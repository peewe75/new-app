/**
 * Pipeline di Seguito: dalla registrazione alla proposta (analisi e
 * costruzione), sincronizzazione con una fonte, approvazione e scarto delle
 * proposte archiviate. Nessuna azione viene eseguita senza approvazione.
 */
import { z } from "zod";
import { approveProposal, discardProposal, ProposalStateError } from "./actions/run.js";
import { formatItalianDateTime } from "./domain/time.js";
import type { ApprovalRequest, Proposal, Recording, RecordingRef, StudioProfile } from "./domain/types.js";
import type { CaseManagement } from "./enrich/case-management.js";
import { ExtractionError } from "./extract/claude-extractor.js";
import { buildProposal } from "./extract/postprocess.js";
import type { Extractor } from "./extract/extractor.js";
import { PlaudAuthError, PlaudNotReadyError } from "./sources/plaud-parse.js";
import { recordingId, type RecordingSource } from "./sources/source.js";
import type { Store } from "./store/store.js";

/** Attesa dopo il primo tentativo non riuscito; raddoppia a ogni tentativo. */
const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const FAILURE_KEY_PREFIX = "failure:";

/** Ultimo tentativo di analisi non riuscito di una registrazione (checkpoint `failure:<id>`). */
const FailureSchema = z.object({
  attempts: z.number().int().positive(),
  lastAt: z.string(),
  /** false: lo stesso tentativo darebbe lo stesso esito; si ripete solo su richiesta. */
  retryable: z.boolean(),
  message: z.string(),
});
type Failure = z.infer<typeof FailureSchema>;

export interface PipelineDeps {
  store: Store;
  extractor: Extractor;
  caseManagement: CaseManagement;
  studio: StudioProfile;
}

export interface SyncResult {
  /** Registrazioni analizzate in questa esecuzione. */
  processed: number;
  /** Registrazioni che avevano già una proposta. */
  skipped: number;
  /** Registrazioni ancora senza trascrizione: riprovate alla prossima esecuzione. */
  notReady: number;
  /** Registrazioni con un'analisi già non riuscita, non ripetuta in questa esecuzione. */
  postponed: number;
  /** Un messaggio in italiano per ogni registrazione non elaborata che richiede attenzione. */
  errors: string[];
}

export interface SyncOptions {
  since?: Date;
  limit?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Ripete subito anche le analisi non riuscite in precedenza (comando manuale). */
  retryFailed?: boolean;
}

/** Dipendenze per eseguire o scartare una proposta già archiviata. */
export interface StoredProposalDeps {
  store: Store;
  caseManagement: CaseManagement;
  studio: StudioProfile;
  /** Cartella dei file generati (.ics, .eml). */
  outboxDir: string;
}

/**
 * Archivia la registrazione e ne costruisce la proposta. Se la proposta esiste
 * già la restituisce così com'è (`created` false), salvo `force`: in quel caso
 * la rigenera, ma mai se contiene già esiti di esecuzione. Una proposta creata
 * nel frattempo da un altro processo (es. poll e serve insieme) non viene mai
 * sovrascritta.
 */
export async function processRecording(
  recording: Recording,
  deps: PipelineDeps,
  opts: { now?: Date; force?: boolean } = {},
): Promise<{ proposal: Proposal; created: boolean }> {
  const { store, extractor, caseManagement, studio } = deps;
  const force = opts.force === true;
  const existing = await store.getProposal(recording.id);
  if (existing !== null && !force) {
    // La registrazione archiviata resta quella su cui è stata costruita la proposta.
    if (!(await store.hasRecording(recording.id))) await store.saveRecording(recording);
    return { proposal: existing, created: false };
  }
  if (existing !== null) assertRegenerable(existing, recording);
  await store.saveRecording(recording);
  const now = opts.now ?? new Date();
  const extraction = await extractor.extract({ recording, studio, now });
  const proposal = await buildProposal({
    recording,
    extraction,
    studio,
    caseManagement,
    extractor: { name: extractor.name, model: extractor.model },
    now,
  });
  if (!force) {
    if (await store.createProposal(proposal)) return { proposal, created: true };
    const current = await store.getProposal(recording.id);
    if (current === null) throw new Error("Archivio: impossibile salvare la proposta, riprovare.");
    return { proposal: current, created: false };
  }
  const current = await store.getProposal(recording.id);
  if (current !== null) assertRegenerable(current, recording);
  await store.saveProposal(proposal);
  return { proposal, created: true };
}

function assertRegenerable(proposal: Proposal, recording: Recording): void {
  if (proposal.executions.length === 0) return;
  throw new ProposalStateError(
    `La proposta per «${recording.title}» è già stata approvata, in tutto o in parte: non può essere rigenerata.`,
  );
}

/**
 * Elabora le registrazioni recenti della fonte che non hanno ancora una
 * proposta. Gli errori di una registrazione non interrompono le altre; quelle
 * non ancora trascritte vengono riprovate alla prossima esecuzione. Un'analisi
 * non riuscita si ripete con attese crescenti, oppure mai in automatico se
 * l'errore non è transitorio (salvo `retryFailed`). Le credenziali Plaud non
 * valide interrompono tutto (PlaudAuthError).
 */
export async function syncSource(
  source: RecordingSource,
  deps: PipelineDeps,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const clock = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const runAt = clock();
  const listOpts: { since?: Date; limit?: number } = {};
  if (opts.since !== undefined) listOpts.since = opts.since;
  if (opts.limit !== undefined) listOpts.limit = opts.limit;
  const refs = await source.listRecent(listOpts);

  const result: SyncResult = { processed: 0, skipped: 0, notReady: 0, postponed: 0, errors: [] };
  for (const ref of refs) {
    const id = recordingId(source.name, ref.externalId);
    const label = refLabel(ref, deps.studio.timezone);
    if ((await deps.store.getProposal(id)) !== null) {
      result.skipped++;
      continue;
    }
    if (!ref.ready) {
      result.notReady++;
      log(`Trascrizione non ancora disponibile: ${label}.`);
      continue;
    }
    const failure = await readFailure(deps.store, id);
    if (failure !== null && opts.retryFailed !== true && !retryDue(failure, clock())) {
      result.postponed++;
      reportPostponed(failure, label, deps.studio.timezone, result, log);
      continue;
    }
    let recording: Recording;
    try {
      recording = await source.fetchRecording(ref.externalId);
    } catch (err) {
      if (err instanceof PlaudAuthError) throw err;
      if (err instanceof PlaudNotReadyError) {
        result.notReady++;
        log(`Trascrizione non ancora disponibile: ${label}.`);
        continue;
      }
      addError(result, log, `${label}: ${errorMessage(err)}`);
      continue;
    }
    try {
      const { proposal, created } = await processRecording(recording, deps, { now: clock() });
      if (!created) {
        // Elaborata nel frattempo da un altro processo.
        result.skipped++;
        continue;
      }
      result.processed++;
      log(`Elaborata: ${label}, ${actionsText(proposal)}.`);
    } catch (err) {
      // Solo gli errori dell'analisi si registrano: ripeterla ha un costo.
      const next = nextFailure(failure, err, clock());
      await deps.store.setCheckpoint(`${FAILURE_KEY_PREFIX}${id}`, JSON.stringify(next));
      const automatic = next.retryable ? "" : " L'analisi non verrà ripetuta automaticamente.";
      addError(result, log, `${label}: ${next.message}${opts.retryFailed === true ? "" : automatic}`);
    }
  }
  await deps.store.setCheckpoint(`lastSync:${source.name}`, runAt.toISOString());
  return result;
}

/** Esegue le azioni approvate di una proposta archiviata e salva l'esito. */
export async function approveStoredProposal(
  proposalId: string,
  request: ApprovalRequest,
  deps: StoredProposalDeps,
  now: Date = new Date(),
): Promise<Proposal> {
  const proposal = await requireProposal(deps.store, proposalId);
  const recording = await deps.store.getRecording(proposal.recordingId);
  if (recording === null) {
    throw new ProposalStateError(
      "La registrazione di questa proposta non è più nell'archivio: impossibile eseguire le azioni.",
    );
  }
  const updated = await approveProposal({
    proposal,
    request,
    recording,
    studio: deps.studio,
    outboxDir: deps.outboxDir,
    caseManagement: deps.caseManagement,
    now,
  });
  await deps.store.saveProposal(updated);
  return updated;
}

/** Scarta una proposta archiviata senza eseguire nulla. */
export async function discardStoredProposal(
  proposalId: string,
  deps: { store: Store },
  now: Date = new Date(),
): Promise<Proposal> {
  const updated = discardProposal(await requireProposal(deps.store, proposalId), now);
  await deps.store.saveProposal(updated);
  return updated;
}

async function requireProposal(store: Store, proposalId: string): Promise<Proposal> {
  const proposal = await store.getProposal(proposalId);
  if (proposal === null) throw new ProposalStateError("Proposta non trovata nell'archivio.");
  return proposal;
}

// ---------------------------------------------------------------------------
// Analisi non riuscite
// ---------------------------------------------------------------------------

/** Ultimo tentativo non riuscito; un checkpoint illeggibile vale come assente. */
async function readFailure(store: Store, id: string): Promise<Failure | null> {
  const raw = await store.getCheckpoint(`${FAILURE_KEY_PREFIX}${id}`);
  if (raw === null) return null;
  try {
    const parsed = FailureSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function nextFailure(previous: Failure | null, err: unknown, now: Date): Failure {
  return {
    attempts: (previous?.attempts ?? 0) + 1,
    lastAt: now.toISOString(),
    retryable: !(err instanceof ExtractionError && !err.retryable),
    message: errorMessage(err),
  };
}

/** Attesa prima del prossimo tentativo: 15 minuti, poi il doppio a ogni errore, al massimo un giorno. */
function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

function nextRetryAt(failure: Failure): Date {
  return new Date(Date.parse(failure.lastAt) + retryDelayMs(failure.attempts));
}

function retryDue(failure: Failure, now: Date): boolean {
  return failure.retryable && now.getTime() >= nextRetryAt(failure).getTime();
}

/** Le analisi da ripetere su richiesta restano tra gli errori; le altre attendono il prossimo tentativo. */
function reportPostponed(
  failure: Failure,
  label: string,
  timeZone: string,
  result: SyncResult,
  log: (msg: string) => void,
): void {
  const when = formatInstant(failure.lastAt, timeZone);
  if (!failure.retryable) {
    addError(result, log, `${label}: analisi non riuscita (${when}): ${failure.message} Non viene ripetuta automaticamente.`);
    return;
  }
  log(
    `Analisi rinviata: ${label}. Ultimo tentativo non riuscito (${when}): ${failure.message} ` +
      `Nuovo tentativo dopo ${formatInstant(nextRetryAt(failure).toISOString(), timeZone)}.`,
  );
}

function addError(result: SyncResult, log: (msg: string) => void, message: string): void {
  result.errors.push(message);
  log(`Errore – ${message}`);
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

/** Es. «Chiamata Mario Rossi» (mercoledì 7 ottobre 2026 alle ore 09:30). */
function refLabel(ref: RecordingRef, timeZone: string): string {
  return `«${ref.title}» (${formatInstant(ref.startedAt, timeZone)})`;
}

function formatInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatItalianDateTime(date, timeZone);
}

function actionsText(proposal: Proposal): string {
  const count = proposal.actions.length;
  return count === 1 ? "1 azione proposta" : `${count} azioni proposte`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return "errore imprevisto durante l'elaborazione.";
}
