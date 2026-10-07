/**
 * Pipeline di Seguito: dalla registrazione alla proposta (analisi e
 * costruzione), sincronizzazione con una fonte, approvazione e scarto delle
 * proposte archiviate. Nessuna azione viene eseguita senza approvazione.
 */
import { approveProposal, discardProposal, ProposalStateError } from "./actions/run.js";
import { formatItalianDateTime } from "./domain/time.js";
import type { ApprovalRequest, Proposal, Recording, RecordingRef, StudioProfile } from "./domain/types.js";
import type { CaseManagement } from "./enrich/case-management.js";
import { buildProposal } from "./extract/postprocess.js";
import type { Extractor } from "./extract/extractor.js";
import { PlaudAuthError, PlaudNotReadyError } from "./sources/plaud-parse.js";
import { recordingId, type RecordingSource } from "./sources/source.js";
import type { Store } from "./store/store.js";

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
  /** Un messaggio in italiano per ogni registrazione non elaborata. */
  errors: string[];
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
 * la rigenera, ma mai se contiene già esiti di esecuzione.
 */
export async function processRecording(
  recording: Recording,
  deps: PipelineDeps,
  opts: { now?: Date; force?: boolean } = {},
): Promise<{ proposal: Proposal; created: boolean }> {
  const { store, extractor, caseManagement, studio } = deps;
  const existing = await store.getProposal(recording.id);
  if (existing !== null && opts.force !== true) {
    // La registrazione archiviata resta quella su cui è stata costruita la proposta.
    if (!(await store.hasRecording(recording.id))) await store.saveRecording(recording);
    return { proposal: existing, created: false };
  }
  if (existing !== null && existing.executions.length > 0) {
    throw new ProposalStateError(
      `La proposta per «${recording.title}» è già stata approvata, in tutto o in parte: non può essere rigenerata.`,
    );
  }
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
  await store.saveProposal(proposal);
  return { proposal, created: true };
}

/**
 * Elabora le registrazioni recenti della fonte che non hanno ancora una
 * proposta. Gli errori di una registrazione non interrompono le altre; quelle
 * non ancora trascritte vengono riprovate alla prossima esecuzione. Le
 * credenziali Plaud non valide interrompono tutto (PlaudAuthError).
 */
export async function syncSource(
  source: RecordingSource,
  deps: PipelineDeps,
  opts: { since?: Date; limit?: number; now?: () => Date; log?: (msg: string) => void } = {},
): Promise<SyncResult> {
  const clock = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const runAt = clock();
  const listOpts: { since?: Date; limit?: number } = {};
  if (opts.since !== undefined) listOpts.since = opts.since;
  if (opts.limit !== undefined) listOpts.limit = opts.limit;
  const refs = await source.listRecent(listOpts);

  const result: SyncResult = { processed: 0, skipped: 0, notReady: 0, errors: [] };
  for (const ref of refs) {
    const label = refLabel(ref, deps.studio.timezone);
    if ((await deps.store.getProposal(recordingId(source.name, ref.externalId))) !== null) {
      result.skipped++;
      continue;
    }
    if (!ref.ready) {
      result.notReady++;
      log(`Trascrizione non ancora disponibile: ${label}.`);
      continue;
    }
    try {
      const recording = await source.fetchRecording(ref.externalId);
      const { proposal } = await processRecording(recording, deps, { now: clock() });
      result.processed++;
      log(`Elaborata: ${label}, ${actionsText(proposal)}.`);
    } catch (err) {
      if (err instanceof PlaudAuthError) throw err;
      if (err instanceof PlaudNotReadyError) {
        result.notReady++;
        log(`Trascrizione non ancora disponibile: ${label}.`);
        continue;
      }
      const message = `${label}: ${errorMessage(err)}`;
      result.errors.push(message);
      log(`Errore – ${message}`);
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

/** Es. «Chiamata Mario Rossi» (mercoledì 7 ottobre 2026 alle ore 09:30). */
function refLabel(ref: RecordingRef, timeZone: string): string {
  const start = new Date(ref.startedAt);
  const when = Number.isNaN(start.getTime()) ? ref.startedAt : formatItalianDateTime(start, timeZone);
  return `«${ref.title}» (${when})`;
}

function actionsText(proposal: Proposal): string {
  const count = proposal.actions.length;
  return count === 1 ? "1 azione proposta" : `${count} azioni proposte`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return "errore imprevisto durante l'elaborazione.";
}
