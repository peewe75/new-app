/**
 * Dall'output del modello alla proposta per l'avvocato: verifica delle
 * citazioni, collegamento al gestionale, avvisi e preselezione delle azioni.
 */
import {
  formatItalianDate,
  formatItalianDateTime,
  isLocalDate,
  isLocalDateTime,
  localDateOf,
  zonedLocalToUtc,
} from "../domain/time.js";
import type {
  ActionPayload,
  ClientMatch,
  ConversationType,
  Evidence,
  ExtractedAction,
  ExtractedParticipant,
  Extraction,
  ParticipantRole,
  Proposal,
  ProposalParticipant,
  ProposedAction,
  Recording,
  ResolvedEvidence,
  Segment,
  StudioProfile,
  Warning,
  WarningCode,
} from "../domain/types.js";
import type { CaseManagement, ClientQuery } from "../enrich/case-management.js";
import {
  CLIENT_CANDIDATE_MIN_SCORE,
  CLIENT_LINK_MIN_SCORE,
  clientForName,
  linkableMatch,
  nameIncludes,
  strongestMatch,
} from "../enrich/client-link.js";

const PRESELECT_MIN_CONFIDENCE = 0.75;
/** Le email non richieste hanno confidenza tra 0,6 e 0,7: si preselezionano solo quelle richieste in chiamata. */
const PRESELECT_MIN_CONFIDENCE_EMAIL = 0.8;
const LOW_CONFIDENCE = 0.6;

/** Ruoli cercati nel gestionale. */
const MATCHABLE_ROLES: ReadonlySet<ParticipantRole> = new Set(["cliente", "potenziale_cliente", "consulente"]);
const CLIENT_ROLES: ReadonlySet<ParticipantRole> = new Set(["cliente", "potenziale_cliente"]);

/**
 * Avvisi che restano visibili ma non tolgono la preselezione: una scadenza
 * processuale lasciata fuori dal calendario è un rischio maggiore di un evento
 * segnato come da verificare.
 */
const NON_GATING_WARNINGS: ReadonlySet<WarningCode> = new Set(["TERMINE_DA_VERIFICARE"]);

/** Riferimenti temporali che diventano falsi se l'email parte in un altro giorno (testo normalizzato). */
const RELATIVE_TIME =
  /\b(?:oggi|ieri|domani|dopodomani|stamattina|stamani|stasera|stanotte|questa mattina|questo pomeriggio|questa sera|(?:la )?settimana (?:prossima|scorsa)|(?:la )?prossima settimana|(?:il )?mese (?:prossimo|scorso)|(?:il )?prossimo mese)\b/g;

type PayloadOf<T extends ActionPayload["type"]> = Extract<ActionPayload, { type: T }>;

/** Controparte che risulta cliente dello studio. */
interface Conflict {
  /** Nome della controparte come indicato nella conversazione. */
  counterpart: string;
  client: ClientMatch;
  matterNumbers: string[];
}

interface ActionContext {
  participants: ProposalParticipant[];
  /** Candidati deboli (es. stesso cognome) dei clienti non collegati: mai collegati in automatico. */
  clientCandidates: ClientMatch[];
  conflicts: Conflict[];
  caseManagement: CaseManagement;
  segments: Segment[];
  timeZone: string;
  now: Date;
}

export interface BuildProposalArgs {
  recording: Recording;
  extraction: Extraction;
  studio: StudioProfile;
  caseManagement: CaseManagement;
  extractor: { name: string; model: string | null };
  now: Date;
}

// ---------------------------------------------------------------------------
// Evidenze
// ---------------------------------------------------------------------------

/** Normalizzazione condivisa per confrontare citazioni e trascrizione. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function resolveEvidence(evidence: Evidence[], segments: Segment[]): ResolvedEvidence[] {
  const byIndex = new Map(segments.map((s) => [s.index, s]));
  return evidence.map((e) => {
    const segment = byIndex.get(e.segment);
    if (segment === undefined) {
      return { segment: e.segment, quote: e.quote, startMs: null, speaker: null, verified: false };
    }
    const next = byIndex.get(e.segment + 1);
    return {
      segment: e.segment,
      quote: e.quote,
      startMs: segment.startMs,
      speaker: segment.speaker,
      verified: quoteFound(e.quote, segment.text, next?.text),
    };
  });
}

/** Vera se la citazione è nel segmento citato o a cavallo con il successivo. */
function quoteFound(quote: string, text: string, nextText: string | undefined): boolean {
  const q = normalizeForMatch(quote);
  if (q === "") return false;
  if (normalizeForMatch(text).includes(q)) return true;
  return nextText !== undefined && normalizeForMatch(`${text} ${nextText}`).includes(q);
}

// ---------------------------------------------------------------------------
// Proposta
// ---------------------------------------------------------------------------

export async function buildProposal(args: BuildProposalArgs): Promise<Proposal> {
  const { recording, extraction, studio, caseManagement, extractor, now } = args;
  const matches = await Promise.all(extraction.participants.map((p) => matchParticipant(p, caseManagement)));
  const participants: ProposalParticipant[] = extraction.participants.map((p, i) => ({
    ...p,
    evidence: resolveEvidence(p.evidence, recording.segments),
    clientMatch: matches[i]?.match ?? null,
  }));
  const ctx: ActionContext = {
    participants,
    clientCandidates: matches.flatMap((m) => (m.candidate === null ? [] : [m.candidate])),
    conflicts: await findConflicts(extraction, participants, caseManagement),
    caseManagement,
    segments: recording.segments,
    timeZone: studio.timezone,
    now,
  };

  const modelActions = await Promise.all(
    extraction.actions.map((action, i) => toProposedAction(action, `a${i + 1}`, ctx)),
  );
  const actions = [...modelActions, transcriptAction(`a${modelActions.length + 1}`, studio)];

  const colleagueWarning = colleagueWarningFor(extraction);
  const warnings: Warning[] = [];
  if (colleagueWarning !== null) warnings.push(colleagueWarning);
  warnings.push(...ctx.conflicts.map(conflictWarning));
  if (extraction.actions.length === 0) {
    warnings.push(warning("NESSUNA_AZIONE", "info", "Dalla conversazione non sono emerse azioni da proporre."));
  }

  const nowIso = now.toISOString();
  return {
    id: recording.id,
    recordingId: recording.id,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: "da_revisionare",
    recording: {
      title: recording.title,
      startedAt: recording.startedAt,
      durationMs: recording.durationMs,
      source: recording.source,
    },
    conversationType: extraction.conversationType,
    summary: extraction.summary,
    participants,
    actions: colleagueWarning === null ? actions : actions.map((a) => ({ ...a, preselected: false })),
    doubts: extraction.doubts.map((d) => ({ text: d.text, evidence: resolveEvidence(d.evidence, recording.segments) })),
    warnings,
    extractor: { name: extractor.name, model: extractor.model },
    executions: [],
  };
}

/**
 * Collegamento al gestionale: automatico solo sopra la soglia sicura; una
 * corrispondenza debole di un cliente (es. solo il cognome) resta un candidato.
 */
async function matchParticipant(
  participant: ExtractedParticipant,
  caseManagement: CaseManagement,
): Promise<{ match: ClientMatch | null; candidate: ClientMatch | null }> {
  const none = { match: null, candidate: null };
  if (!MATCHABLE_ROLES.has(participant.role)) return none;
  const query = participantQuery(participant);
  if (query === null) return none;
  const matches = await caseManagement.findClients(query);
  const match = linkableMatch(matches);
  if (match !== null) return { match, candidate: null };
  const best = strongestMatch(matches);
  const candidate =
    CLIENT_ROLES.has(participant.role) && best !== null && best.score >= CLIENT_CANDIDATE_MIN_SCORE ? best : null;
  return { match: null, candidate };
}

function participantQuery(participant: ExtractedParticipant): ClientQuery | null {
  const { name, email, phone, organization } = participant;
  if (name === null && email === null && phone === null && organization === null) return null;
  return { name, email, phone, organization };
}

/**
 * Art. 24 CDF: controparti (partecipanti con quel ruolo e controparti degli
 * incarichi) che risultano clienti dello studio. Basta lo stesso cognome:
 * meglio un controllo in più che un conflitto non visto.
 */
async function findConflicts(
  extraction: Extraction,
  participants: ProposalParticipant[],
  caseManagement: CaseManagement,
): Promise<Conflict[]> {
  const ownClients = new Set(
    participants.flatMap((p) => (CLIENT_ROLES.has(p.role) && p.clientMatch !== null ? [p.clientMatch.clientId] : [])),
  );
  const counterparts: Array<{ label: string; query: ClientQuery }> = [
    ...extraction.participants.flatMap((p) => {
      const label = p.organization ?? p.name;
      const query = participantQuery(p);
      return p.role === "controparte" && label !== null && query !== null ? [{ label, query }] : [];
    }),
    ...extraction.actions.flatMap((a) =>
      a.type === "incarico" && a.counterpart?.trim() ? [{ label: a.counterpart.trim(), query: { name: a.counterpart } }] : [],
    ),
  ];
  const conflicts: Conflict[] = [];
  for (const { label, query } of counterparts) {
    for (const client of await caseManagement.findClients(query)) {
      if (client.score < CLIENT_CANDIDATE_MIN_SCORE || ownClients.has(client.clientId)) continue;
      if (conflicts.some((c) => c.client.clientId === client.clientId)) continue;
      const matters = await caseManagement.listMatters(client.clientId);
      conflicts.push({ counterpart: label, client, matterNumbers: matters.map((m) => m.number) });
    }
  }
  return conflicts;
}

async function toProposedAction(action: ExtractedAction, id: string, ctx: ActionContext): Promise<ProposedAction> {
  const { confidence: rawConfidence, evidence: rawEvidence, rationale, ...extracted } = action;
  const confidence = clamp01(rawConfidence);
  const evidence = resolveEvidence(rawEvidence, ctx.segments);
  const { payload, warnings: typeWarnings } = await checkPayload(extracted, ctx);

  const warnings: Warning[] = [];
  if (!evidence.some((e) => e.verified)) {
    warnings.push(
      warning(
        "EVIDENZA_NON_VERIFICATA",
        "attenzione",
        evidence.length === 0
          ? "Nessuna citazione a supporto: verificare sulla trascrizione."
          : "Le citazioni indicate non si ritrovano nella trascrizione: verificare.",
      ),
    );
  }
  warnings.push(...typeWarnings);
  if (confidence < LOW_CONFIDENCE) {
    warnings.push(
      warning(
        "CONFIDENZA_BASSA",
        "info",
        `Affidabilità della proposta bassa (${Math.round(confidence * 100)}%): verificarla con attenzione.`,
      ),
    );
  }

  const minConfidence = payload.type === "email" ? PRESELECT_MIN_CONFIDENCE_EMAIL : PRESELECT_MIN_CONFIDENCE;
  return {
    id,
    origin: "modello",
    payload,
    confidence,
    evidence,
    rationale,
    preselected: confidence >= minConfidence && !warnings.some(blocksPreselection),
    warnings,
  };
}

function transcriptAction(id: string, studio: StudioProfile): ProposedAction {
  return {
    id,
    origin: "sistema",
    payload: { type: "invio_trascrizione", to: studio.studioEmail },
    confidence: 1,
    evidence: [],
    rationale: "Archiviazione della trascrizione nella casella dello studio",
    preselected: true,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Controlli per tipo di azione
// ---------------------------------------------------------------------------

async function checkPayload(
  payload: ActionPayload,
  ctx: ActionContext,
): Promise<{ payload: ActionPayload; warnings: Warning[] }> {
  switch (payload.type) {
    case "appuntamento":
      return { payload, warnings: appointmentWarnings(payload, ctx) };
    case "scadenza":
      return { payload, warnings: deadlineWarnings(payload, ctx) };
    case "documenti":
    case "attivita":
      return { payload, warnings: dueDateWarnings(payload.dueDate) };
    case "email":
      return checkEmail(payload, ctx.participants);
    case "incarico":
      return { payload, warnings: await engagementWarnings(payload, ctx) };
    case "accordo_economico":
    case "invio_trascrizione":
      return { payload, warnings: [] };
  }
}

function appointmentWarnings(p: PayloadOf<"appuntamento">, ctx: ActionContext): Warning[] {
  if (p.start === null) {
    return p.status === "fissato"
      ? [
          warning(
            "DATA_MANCANTE",
            "attenzione",
            "Appuntamento indicato come fissato ma privo di data e ora: completarle prima dell'approvazione.",
          ),
        ]
      : [];
  }
  if (!isLocalDateTime(p.start)) {
    return [
      warning(
        "DATA_NON_VALIDA",
        "attenzione",
        `Data e ora dell'appuntamento non valide («${p.start}»): correggerle prima dell'approvazione.`,
      ),
    ];
  }
  const start = zonedLocalToUtc(p.start, ctx.timeZone);
  if (start.getTime() < ctx.now.getTime()) {
    return [
      warning(
        "DATA_PASSATA",
        "attenzione",
        `L'appuntamento (${formatItalianDateTime(start, ctx.timeZone)}) risulta già trascorso: verificare la data.`,
      ),
    ];
  }
  return [];
}

function deadlineWarnings(p: PayloadOf<"scadenza">, ctx: ActionContext): Warning[] {
  const out: Warning[] = [];
  if (p.date === null) {
    out.push(warning("DATA_MANCANTE", "attenzione", "Scadenza priva di data: completarla prima dell'approvazione."));
  } else if (!isLocalDate(p.date)) {
    out.push(
      warning(
        "DATA_NON_VALIDA",
        "attenzione",
        `Data della scadenza non valida («${p.date}»): correggerla prima dell'approvazione.`,
      ),
    );
  } else if (p.date < localDateOf(ctx.now, ctx.timeZone)) {
    out.push(
      warning(
        "DATA_PASSATA",
        "attenzione",
        `La scadenza (${formatItalianDate(p.date)}) risulta già trascorsa: verificare la data.`,
      ),
    );
  }
  if (p.time !== null && !isLocalDateTime(`2000-01-01T${p.time}`)) {
    out.push(
      warning(
        "DATA_NON_VALIDA",
        "attenzione",
        `Orario della scadenza non valido («${p.time}»): correggerlo prima dell'approvazione.`,
      ),
    );
  }
  if (p.kind === "processuale") {
    out.push(
      warning(
        "TERMINE_DA_VERIFICARE",
        "attenzione",
        p.computation === null
          ? "Data riferita nella conversazione (per esempio un'udienza già fissata): verificarla sul fascicolo. In calendario l'evento è segnato come da verificare."
          : "Termine calcolato automaticamente: verificarlo sul fascicolo e sul codice prima di farvi affidamento. In calendario l'evento è segnato come da verificare.",
      ),
    );
  }
  return out;
}

function dueDateWarnings(dueDate: string | null): Warning[] {
  if (dueDate === null || isLocalDate(dueDate)) return [];
  return [warning("DATA_NON_VALIDA", "info", `Data di scadenza non valida («${dueDate}»): correggerla se necessario.`)];
}

/**
 * Cliente dell'incarico risolto come all'esecuzione: il nome indicato prevale
 * sul collegamento del partecipante, se non è compatibile con esso.
 */
async function engagementWarnings(p: PayloadOf<"incarico">, ctx: ActionContext): Promise<Warning[]> {
  const out = ctx.conflicts.map(conflictWarning);
  const linked = linkedClient(ctx.participants);
  const name = p.clientName?.trim();
  const byName = name ? await ctx.caseManagement.findClients({ name }) : [];
  const client = name ? clientForName(byName, linked) : linked;
  if (client !== null) return out;
  const candidates = uniqueClients([
    ...byName.filter((m) => m.score >= CLIENT_CANDIDATE_MIN_SCORE),
    ...ctx.clientCandidates,
  ]);
  if (candidates.length > 0) {
    const names = candidates.map((c) => c.displayName).join(", ");
    out.push(
      warning(
        "CLIENTE_DA_VERIFICARE",
        "attenzione",
        `Nel gestionale risulta un cliente con nome simile (${names}), non collegato in automatico. ` +
          "Se si tratta della stessa persona, indicarne nome e cognome nel campo «Cliente»; altrimenti, " +
          "all'approvazione verrà creata una nuova anagrafica.",
      ),
    );
    return out;
  }
  out.push(
    warning(
      "CLIENTE_NON_TROVATO",
      "info",
      "Il cliente non risulta nel gestionale: all'approvazione verrà creata una nuova anagrafica.",
    ),
  );
  return out;
}

/** Il cliente collegato con il punteggio più alto tra i partecipanti clienti. */
function linkedClient(participants: ProposalParticipant[]): ClientMatch | null {
  return strongestMatch(
    participants.flatMap((p) =>
      CLIENT_ROLES.has(p.role) && p.clientMatch !== null && p.clientMatch.score >= CLIENT_LINK_MIN_SCORE
        ? [p.clientMatch]
        : [],
    ),
  );
}

function uniqueClients(matches: ClientMatch[]): ClientMatch[] {
  return matches.filter((m, i) => matches.findIndex((x) => x.clientId === m.clientId) === i);
}

function checkEmail(
  p: PayloadOf<"email">,
  participants: ProposalParticipant[],
): { payload: ActionPayload; warnings: Warning[] } {
  const { payload, warnings } = completeRecipient(p, participants);
  if (p.recipientRole === "controparte") {
    warnings.push(
      warning(
        "CONTROPARTE_DIRETTA",
        "attenzione",
        "Comunicazione diretta alla controparte: se è assistita da un collega, l'art. 41 del Codice deontologico " +
          "forense consente di scriverle solo per richiedere comportamenti determinati, intimare messe in mora o " +
          "evitare prescrizioni o decadenze, sempre con copia al collega. Verificare prima dell'invio.",
      ),
    );
  }
  const relative = relativeTimeWords(p.body);
  if (relative.length > 0) {
    warnings.push(
      warning(
        "RIFERIMENTO_TEMPORALE",
        "info",
        `Il testo contiene riferimenti temporali relativi (${relative.map((w) => `«${w}»`).join(", ")}): ` +
          "se l'email viene inviata in un giorno diverso da quello della conversazione, sostituirli con le date.",
      ),
    );
  }
  return { payload, warnings };
}

/** Completa l'indirizzo del destinatario dal gestionale quando non è stato detto in chiamata. */
function completeRecipient(
  p: PayloadOf<"email">,
  participants: ProposalParticipant[],
): { payload: PayloadOf<"email">; warnings: Warning[] } {
  if (p.recipientEmail !== null && p.recipientEmail.trim() !== "") return { payload: p, warnings: [] };
  const email = clientEmailFor(p, participants);
  if (email !== null) return { payload: { ...p, recipientEmail: email }, warnings: [] };
  return {
    payload: { ...p, recipientEmail: null },
    warnings: [
      warning("DATI_CLIENTE_MANCANTI", "attenzione", "Indirizzo email del destinatario da completare prima dell'invio."),
    ],
  };
}

/**
 * Indirizzo dal gestionale solo per le email al cliente: il destinatario deve
 * essere un cliente collegato, riconosciuto per nome a parole intere
 * («Dott. Grossi» non è «Rossi»). Senza nome vale l'unico cliente collegato.
 */
function clientEmailFor(p: PayloadOf<"email">, participants: ProposalParticipant[]): string | null {
  if (!CLIENT_ROLES.has(p.recipientRole)) return null;
  const linked = participants.filter((x) => CLIENT_ROLES.has(x.role) && x.clientMatch?.email);
  const named = p.recipientName?.trim()
    ? linked.filter((x) => [x.name, x.clientMatch?.displayName].some((n) => nameIncludes(n, p.recipientName)))
    : linked;
  const emails = [...new Set(named.flatMap((x) => (x.clientMatch?.email ? [x.clientMatch.email] : [])))];
  return emails.length === 1 ? (emails[0] ?? null) : null;
}

/** Parole come «oggi» o «questa mattina» presenti nel testo, senza ripetizioni. */
function relativeTimeWords(body: string): string[] {
  return [...new Set(normalizeForMatch(body).match(RELATIVE_TIME) ?? [])];
}

// ---------------------------------------------------------------------------
// Avvisi a livello di conversazione
// ---------------------------------------------------------------------------

/**
 * Art. 38, comma 2, CDF (codice interno COLLEGA_ART38): rileva solo i colleghi
 * che hanno preso parte alla conversazione.
 */
function colleagueWarningFor(extraction: Extraction): Warning | null {
  const withColleague = extraction.participants.some((p) => p.role === "collega_avvocato" && p.isSpeaker);
  if (!withColleague) return null;
  const oneToOne = extraction.participants.filter((p) => p.isSpeaker).length <= 2;
  return warning("COLLEGA_ART38", "bloccante", colleagueMessage(extraction.conversationType, oneToOne));
}

const CDF_ARTICLE = "art. 38, comma 2, del Codice deontologico forense";
const SPEAKERPHONE_NOTE =
  "Se il collega partecipava al telefono o in vivavoce, vale il divieto previsto per le conversazioni telefoniche; " +
  "anche far ascoltare la telefonata a terzi in vivavoce senza avvisare il collega ha rilievo disciplinare " +
  "(CNF, sentenza n. 7 del 2016).";
const NOT_PRESELECTED = "Nessuna azione è stata preselezionata.";

function colleagueMessage(type: ConversationType, oneToOne: boolean): string {
  const phoneBan = `l'${CDF_ARTICLE} vieta di registrare una conversazione telefonica con un collega`;
  switch (type) {
    case "telefonata":
      return `Conversazione telefonica con un collega: ${phoneBan}. Valutare la cancellazione della registrazione. ${NOT_PRESELECTED}`;
    case "videochiamata":
      if (oneToOne) {
        return (
          "Videochiamata a due con un collega: in via prudenziale va trattata come una conversazione telefonica, " +
          `e ${phoneBan}. Valutare la cancellazione della registrazione. ${NOT_PRESELECTED}`
        );
      }
      return meetingMessage("Videochiamata");
    case "riunione_in_presenza":
      return meetingMessage("Riunione");
    case "non_determinabile":
      return (
        `Conversazione con un collega: ${phoneBan} e consente la registrazione di una riunione solo con il consenso ` +
        `di tutti i presenti. ${SPEAKERPHONE_NOTE} Verificare il tipo di conversazione e il consenso; valutare la ` +
        `cancellazione della registrazione. ${NOT_PRESELECTED}`
      );
  }
}

function meetingMessage(kind: "Riunione" | "Videochiamata"): string {
  return (
    `${kind} con un collega: la registrazione è consentita solo con il consenso di tutti i presenti ` +
    `(${CDF_ARTICLE}). ${SPEAKERPHONE_NOTE} Verificare il consenso e le modalità di partecipazione prima di ` +
    `utilizzarla. ${NOT_PRESELECTED}`
  );
}

function conflictWarning(conflict: Conflict): Warning {
  const { matterNumbers } = conflict;
  const matters =
    matterNumbers.length === 0
      ? ""
      : ` (${matterNumbers.length === 1 ? "pratica" : "pratiche"} ${matterNumbers.join(", ")})`;
  return warning(
    "CONFLITTO_INTERESSI",
    "attenzione",
    `Possibile conflitto di interessi (art. 24 del Codice deontologico forense): la controparte ` +
      `«${conflict.counterpart}» potrebbe corrispondere a ${conflict.client.displayName}, cliente dello studio${matters}. ` +
      "Verificare prima di accettare l'incarico.",
  );
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function warning(code: WarningCode, severity: Warning["severity"], message: string): Warning {
  return { code, severity, message };
}

function blocksPreselection(w: Warning): boolean {
  return (w.severity === "attenzione" || w.severity === "bloccante") && !NON_GATING_WARNINGS.has(w.code);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
