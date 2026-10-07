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
import type { CaseManagement } from "../enrich/case-management.js";

const CLIENT_MATCH_MIN_SCORE = 0.6;
const PRESELECT_MIN_CONFIDENCE = 0.75;
const LOW_CONFIDENCE = 0.6;

/** Ruoli cercati nel gestionale. */
const MATCHABLE_ROLES: ReadonlySet<ParticipantRole> = new Set(["cliente", "potenziale_cliente", "consulente"]);
const CLIENT_ROLES: ReadonlySet<ParticipantRole> = new Set(["cliente", "potenziale_cliente"]);

type PayloadOf<T extends ActionPayload["type"]> = Extract<ActionPayload, { type: T }>;

interface ActionContext {
  participants: ProposalParticipant[];
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
  const participants = await Promise.all(
    extraction.participants.map((p) => toProposalParticipant(p, recording.segments, caseManagement)),
  );
  const ctx: ActionContext = { participants, segments: recording.segments, timeZone: studio.timezone, now };

  const modelActions = extraction.actions.map((action, i) => toProposedAction(action, `a${i + 1}`, ctx));
  const actions = [...modelActions, transcriptAction(`a${modelActions.length + 1}`, studio)];

  const colleagueWarning = colleagueWarningFor(extraction);
  const warnings: Warning[] = [];
  if (colleagueWarning !== null) warnings.push(colleagueWarning);
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

async function toProposalParticipant(
  participant: ExtractedParticipant,
  segments: Segment[],
  caseManagement: CaseManagement,
): Promise<ProposalParticipant> {
  return {
    ...participant,
    evidence: resolveEvidence(participant.evidence, segments),
    clientMatch: await findClientMatch(participant, caseManagement),
  };
}

async function findClientMatch(
  participant: ExtractedParticipant,
  caseManagement: CaseManagement,
): Promise<ClientMatch | null> {
  if (!MATCHABLE_ROLES.has(participant.role)) return null;
  const { name, email, phone, organization } = participant;
  if (name === null && email === null && phone === null && organization === null) return null;
  const matches = await caseManagement.findClients({ name, email, phone, organization });
  const best = matches.reduce<ClientMatch | null>((top, m) => (top === null || m.score > top.score ? m : top), null);
  return best !== null && best.score >= CLIENT_MATCH_MIN_SCORE ? best : null;
}

function toProposedAction(action: ExtractedAction, id: string, ctx: ActionContext): ProposedAction {
  const { confidence: rawConfidence, evidence: rawEvidence, rationale, ...extracted } = action;
  const confidence = clamp01(rawConfidence);
  const evidence = resolveEvidence(rawEvidence, ctx.segments);
  const { payload, warnings: typeWarnings } = checkPayload(extracted, ctx);

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

  return {
    id,
    origin: "modello",
    payload,
    confidence,
    evidence,
    rationale,
    preselected: confidence >= PRESELECT_MIN_CONFIDENCE && !warnings.some(isBlocking),
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

function checkPayload(payload: ActionPayload, ctx: ActionContext): { payload: ActionPayload; warnings: Warning[] } {
  switch (payload.type) {
    case "appuntamento":
      return { payload, warnings: appointmentWarnings(payload, ctx) };
    case "scadenza":
      return { payload, warnings: deadlineWarnings(payload, ctx) };
    case "documenti":
    case "attivita":
      return { payload, warnings: dueDateWarnings(payload.dueDate) };
    case "email":
      return completeEmail(payload, ctx.participants);
    case "incarico":
      return { payload, warnings: engagementWarnings(ctx.participants) };
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
        "Termine calcolato automaticamente: verificarlo sul fascicolo e sul codice prima di farvi affidamento.",
      ),
    );
  }
  return out;
}

function dueDateWarnings(dueDate: string | null): Warning[] {
  if (dueDate === null || isLocalDate(dueDate)) return [];
  return [warning("DATA_NON_VALIDA", "info", `Data di scadenza non valida («${dueDate}»): correggerla se necessario.`)];
}

function engagementWarnings(participants: ProposalParticipant[]): Warning[] {
  const clientKnown = participants.some((p) => CLIENT_ROLES.has(p.role) && p.clientMatch !== null);
  if (clientKnown) return [];
  return [
    warning(
      "CLIENTE_NON_TROVATO",
      "info",
      "Il cliente non risulta nel gestionale: all'approvazione verrà creata una nuova anagrafica.",
    ),
  ];
}

/** Completa l'indirizzo del destinatario dal gestionale quando non è stato detto in chiamata. */
function completeEmail(
  p: PayloadOf<"email">,
  participants: ProposalParticipant[],
): { payload: ActionPayload; warnings: Warning[] } {
  if (p.recipientEmail !== null && p.recipientEmail.trim() !== "") return { payload: p, warnings: [] };
  const email = recipientEmailFromCaseManagement(p, participants);
  if (email !== null) return { payload: { ...p, recipientEmail: email }, warnings: [] };
  return {
    payload: { ...p, recipientEmail: null },
    warnings: [
      warning("DATI_CLIENTE_MANCANTI", "attenzione", "Indirizzo email del destinatario da completare prima dell'invio."),
    ],
  };
}

function recipientEmailFromCaseManagement(p: PayloadOf<"email">, participants: ProposalParticipant[]): string | null {
  const recipient = p.recipientName === null ? "" : normalizeForMatch(p.recipientName);
  if (recipient !== "") {
    const byName = participants.find(
      (x) => x.clientMatch?.email && [x.name, x.clientMatch.displayName].some((n) => namesMatch(recipient, n)),
    );
    if (byName?.clientMatch?.email) return byName.clientMatch.email;
  }
  if (CLIENT_ROLES.has(p.recipientRole)) {
    const matched = participants.filter((x) => CLIENT_ROLES.has(x.role) && x.clientMatch !== null);
    const only = matched.length === 1 ? matched[0] : undefined;
    if (only?.clientMatch?.email) return only.clientMatch.email;
  }
  return null;
}

/** Contenimento reciproco dei nomi normalizzati. */
function namesMatch(normalizedRecipient: string, name: string | null): boolean {
  if (name === null) return false;
  const candidate = normalizeForMatch(name);
  return candidate !== "" && (candidate.includes(normalizedRecipient) || normalizedRecipient.includes(candidate));
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
  return withColleague ? warning("COLLEGA_ART38", "bloccante", colleagueMessage(extraction.conversationType)) : null;
}

const CDF_ARTICLE = "art. 38, comma 2, del Codice deontologico forense";

function colleagueMessage(type: ConversationType): string {
  switch (type) {
    case "telefonata":
      return (
        `Conversazione telefonica con un collega: l'${CDF_ARTICLE} vieta di registrare ` +
        "una conversazione telefonica con un collega. Valutare la cancellazione della registrazione; " +
        "nessuna azione è stata preselezionata."
      );
    case "riunione_in_presenza":
    case "videochiamata":
      return (
        "Riunione con un collega: la registrazione è consentita solo con il consenso di tutti i presenti " +
        `(${CDF_ARTICLE}). Verificare il consenso prima di utilizzarla; ` +
        "nessuna azione è stata preselezionata."
      );
    case "non_determinabile":
      return (
        `Conversazione con un collega: l'${CDF_ARTICLE} vieta di registrare una ` +
        "conversazione telefonica con un collega e consente la registrazione di una riunione solo con il consenso " +
        "di tutti i presenti. Verificare il tipo di conversazione e il consenso; valutare la cancellazione della " +
        "registrazione. Nessuna azione è stata preselezionata."
      );
  }
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function warning(code: WarningCode, severity: Warning["severity"], message: string): Warning {
  return { code, severity, message };
}

function isBlocking(w: Warning): boolean {
  return w.severity === "attenzione" || w.severity === "bloccante";
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
