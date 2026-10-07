/**
 * Contratti di dominio condivisi da tutti i moduli di Seguito.
 *
 * Flusso: Recording (trascrizione) -> Extraction (output del modello AI)
 *   -> Proposal (azioni proposte, arricchite e verificate) -> approvazione
 *   -> ExecutionResult (cosa è stato fatto davvero).
 *
 * Gli schemi `Extraction*` sono inviati al modello come JSON Schema
 * (structured outputs): niente vincoli numerici o di lunghezza, tutti i campi
 * obbligatori (eventualmente `nullable`), nessun oggetto aperto.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Registrazione e trascrizione
// ---------------------------------------------------------------------------

export const SegmentSchema = z.object({
  /** Posizione del segmento nella trascrizione (0-based). Le evidenze lo citano. */
  index: z.number().int(),
  startMs: z.number(),
  endMs: z.number().nullable(),
  /** Etichetta originale del parlante, es. "Speaker 1". */
  speaker: z.string(),
  text: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const RecordingSourceNameSchema = z.enum(["plaud", "file"]);
export type RecordingSourceName = z.infer<typeof RecordingSourceNameSchema>;

export const RecordingSchema = z.object({
  /** Id interno stabile: `${source}:${externalId}`. */
  id: z.string(),
  source: RecordingSourceNameSchema,
  externalId: z.string(),
  title: z.string(),
  /** Inizio registrazione, ISO 8601 con offset (es. "2026-10-07T07:30:00.000Z"). */
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  segments: z.array(SegmentSchema),
  /** Riassunto generato da Plaud con il template dello studio, se disponibile. */
  plaudSummary: z.string().nullable(),
  fetchedAt: z.string(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const RecordingRefSchema = z.object({
  externalId: z.string(),
  title: z.string(),
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  /** true quando la trascrizione è già disponibile alla fonte. */
  ready: z.boolean(),
});
export type RecordingRef = z.infer<typeof RecordingRefSchema>;

// ---------------------------------------------------------------------------
// Output del modello AI (structured outputs)
// ---------------------------------------------------------------------------

export const EvidenceSchema = z.object({
  /** Indice del segmento della trascrizione da cui è tratta l'informazione. */
  segment: z.number().int(),
  /** Citazione testuale (breve, letterale) dal segmento. */
  quote: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ParticipantRoleSchema = z.enum([
  "avvocato_studio",
  "cliente",
  "potenziale_cliente",
  "controparte",
  "collega_avvocato",
  "consulente",
  "altro",
  "sconosciuto",
]);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;

export const ConversationTypeSchema = z.enum([
  "telefonata",
  "riunione_in_presenza",
  "videochiamata",
  "non_determinabile",
]);
export type ConversationType = z.infer<typeof ConversationTypeSchema>;

export const ExtractedParticipantSchema = z.object({
  /** Etichetta del parlante nella trascrizione, null se citato ma non presente. */
  speakerLabel: z.string().nullable(),
  isSpeaker: z.boolean(),
  name: z.string().nullable(),
  role: ParticipantRoleSchema,
  organization: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
});
export type ExtractedParticipant = z.infer<typeof ExtractedParticipantSchema>;

const actionCommon = {
  /** Fiducia del modello, 0..1 (validata e limitata lato client). */
  confidence: z.number(),
  evidence: z.array(EvidenceSchema),
  /** Perché l'azione è proposta, una frase. */
  rationale: z.string(),
};

/** Date locali nel fuso dello studio: "YYYY-MM-DD"; date-ora: "YYYY-MM-DDTHH:mm". */
export const AppointmentActionSchema = z.object({
  type: z.literal("appuntamento"),
  title: z.string(),
  status: z.enum(["fissato", "da_fissare"]),
  start: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  location: z.string().nullable(),
  mode: z.enum(["in_studio", "telefonico", "videochiamata", "altro"]).nullable(),
  participants: z.array(z.string()),
  notes: z.string().nullable(),
  ...actionCommon,
});

export const EngagementActionSchema = z.object({
  type: z.literal("incarico"),
  status: z.enum(["conferito", "in_valutazione", "non_conferito"]),
  clientName: z.string().nullable(),
  subject: z.string(),
  matterType: z.string().nullable(),
  counterpart: z.string().nullable(),
  urgency: z.string().nullable(),
  notes: z.string().nullable(),
  ...actionCommon,
});

export const FeeAgreementActionSchema = z.object({
  type: z.literal("accordo_economico"),
  description: z.string(),
  /** true se concordato, false se solo proposto/discusso. */
  agreed: z.boolean(),
  amount: z.number().nullable(),
  currency: z.string(),
  basis: z.enum(["forfait", "orario", "per_fasi", "percentuale", "altro"]).nullable(),
  hourlyRate: z.number().nullable(),
  /** true se l'importo è "oltre IVA e CPA". */
  plusVatAndCpa: z.boolean().nullable(),
  advanceAmount: z.number().nullable(),
  paymentTerms: z.string().nullable(),
  ...actionCommon,
});

export const DeadlineActionSchema = z.object({
  type: z.literal("scadenza"),
  title: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  kind: z.enum(["processuale", "contrattuale", "amministrativa", "altro"]),
  legalBasis: z.string().nullable(),
  /** Come è stata calcolata la data, es. "notifica 02/10/2026 + 40 giorni". */
  computation: z.string().nullable(),
  notes: z.string().nullable(),
  ...actionCommon,
});

export const DocumentsActionSchema = z.object({
  type: z.literal("documenti"),
  direction: z.enum(["da_ricevere", "da_inviare"]),
  items: z.array(z.string()),
  counterpartName: z.string().nullable(),
  dueDate: z.string().nullable(),
  ...actionCommon,
});

export const EmailActionSchema = z.object({
  type: z.literal("email"),
  recipientName: z.string().nullable(),
  recipientEmail: z.string().nullable(),
  recipientRole: ParticipantRoleSchema,
  subject: z.string(),
  /** Bozza completa in italiano formale, SENZA firma (la aggiunge il sistema). */
  body: z.string(),
  purpose: z.string(),
  ...actionCommon,
});

export const TaskActionSchema = z.object({
  type: z.literal("attivita"),
  description: z.string(),
  assignee: z.string().nullable(),
  dueDate: z.string().nullable(),
  ...actionCommon,
});

export const ExtractedActionSchema = z.discriminatedUnion("type", [
  AppointmentActionSchema,
  EngagementActionSchema,
  FeeAgreementActionSchema,
  DeadlineActionSchema,
  DocumentsActionSchema,
  EmailActionSchema,
  TaskActionSchema,
]);
export type ExtractedAction = z.infer<typeof ExtractedActionSchema>;
export type ExtractedActionType = ExtractedAction["type"];

export const ExtractionDoubtSchema = z.object({
  text: z.string(),
  evidence: z.array(EvidenceSchema),
});

export const ExtractionSchema = z.object({
  conversationType: ConversationTypeSchema,
  /** Sintesi in italiano, massimo 5 righe. */
  summary: z.string(),
  participants: z.array(ExtractedParticipantSchema),
  actions: z.array(ExtractedActionSchema),
  /** Punti ambigui o contraddittori da verificare con il cliente. */
  doubts: z.array(ExtractionDoubtSchema),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

// ---------------------------------------------------------------------------
// Proposta (ciò che l'avvocato vede e approva)
// ---------------------------------------------------------------------------

/** Azione generata dal sistema, non dal modello. */
export const SendTranscriptActionSchema = z.object({
  type: z.literal("invio_trascrizione"),
  to: z.string(),
});

export const ActionPayloadSchema = z.discriminatedUnion("type", [
  AppointmentActionSchema.omit({ confidence: true, evidence: true, rationale: true }),
  EngagementActionSchema.omit({ confidence: true, evidence: true, rationale: true }),
  FeeAgreementActionSchema.omit({ confidence: true, evidence: true, rationale: true }),
  DeadlineActionSchema.omit({ confidence: true, evidence: true, rationale: true }),
  DocumentsActionSchema.omit({ confidence: true, evidence: true, rationale: true }),
  EmailActionSchema.omit({ confidence: true, evidence: true, rationale: true }),
  TaskActionSchema.omit({ confidence: true, evidence: true, rationale: true }),
  SendTranscriptActionSchema,
]);
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;
export type ActionType = ActionPayload["type"];

export const WarningCodeSchema = z.enum([
  "COLLEGA_ART38",
  "EVIDENZA_NON_VERIFICATA",
  "DATA_PASSATA",
  "DATA_MANCANTE",
  "DATA_NON_VALIDA",
  "TERMINE_DA_VERIFICARE",
  "DATI_CLIENTE_MANCANTI",
  "CLIENTE_NON_TROVATO",
  "CONFIDENZA_BASSA",
  "NESSUNA_AZIONE",
]);
export type WarningCode = z.infer<typeof WarningCodeSchema>;

export const WarningSchema = z.object({
  code: WarningCodeSchema,
  severity: z.enum(["info", "attenzione", "bloccante"]),
  message: z.string(),
});
export type Warning = z.infer<typeof WarningSchema>;

export const ResolvedEvidenceSchema = z.object({
  segment: z.number().int(),
  quote: z.string(),
  /** Inizio del segmento citato; null se l'indice non esiste. */
  startMs: z.number().nullable(),
  speaker: z.string().nullable(),
  /** true se la citazione si ritrova (normalizzata) nel segmento indicato. */
  verified: z.boolean(),
});
export type ResolvedEvidence = z.infer<typeof ResolvedEvidenceSchema>;

export const ProposedActionSchema = z.object({
  /** Id stabile dentro la proposta: "a1", "a2", ... */
  id: z.string(),
  origin: z.enum(["modello", "sistema"]),
  payload: ActionPayloadSchema,
  confidence: z.number(),
  evidence: z.array(ResolvedEvidenceSchema),
  rationale: z.string(),
  /** Casella già spuntata nell'interfaccia. */
  preselected: z.boolean(),
  warnings: z.array(WarningSchema),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ClientMatchSchema = z.object({
  clientId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  matterIds: z.array(z.string()),
  /** 0..1 */
  score: z.number(),
  matchedOn: z.enum(["nome", "email", "telefono", "organizzazione"]),
});
export type ClientMatch = z.infer<typeof ClientMatchSchema>;

export const ProposalParticipantSchema = ExtractedParticipantSchema.omit({ evidence: true }).extend({
  evidence: z.array(ResolvedEvidenceSchema),
  clientMatch: ClientMatchSchema.nullable(),
});
export type ProposalParticipant = z.infer<typeof ProposalParticipantSchema>;

export const ExecutionArtifactSchema = z.object({
  kind: z.enum(["ics", "eml", "gestionale", "altro"]),
  label: z.string(),
  /** Percorso relativo alla cartella outbox (per i file generati). */
  path: z.string().nullable(),
  /** Riferimento esterno (es. id nota nel gestionale). */
  ref: z.string().nullable(),
});
export type ExecutionArtifact = z.infer<typeof ExecutionArtifactSchema>;

export const ExecutionResultSchema = z.object({
  actionId: z.string(),
  executedAt: z.string(),
  status: z.enum(["ok", "errore", "saltata"]),
  message: z.string(),
  artifacts: z.array(ExecutionArtifactSchema),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ProposalStatusSchema = z.enum([
  "da_revisionare",
  "eseguita",
  "eseguita_parzialmente",
  "scartata",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalSchema = z.object({
  /** Uguale a recordingId: una proposta per registrazione. */
  id: z.string(),
  recordingId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: ProposalStatusSchema,
  recording: z.object({
    title: z.string(),
    startedAt: z.string(),
    durationMs: z.number().nullable(),
    source: RecordingSourceNameSchema,
  }),
  conversationType: ConversationTypeSchema,
  summary: z.string(),
  participants: z.array(ProposalParticipantSchema),
  actions: z.array(ProposedActionSchema),
  doubts: z.array(z.object({ text: z.string(), evidence: z.array(ResolvedEvidenceSchema) })),
  /** Avvisi a livello di conversazione (es. art. 38, comma 2, CDF). */
  warnings: z.array(WarningSchema),
  extractor: z.object({ name: z.string(), model: z.string().nullable() }),
  executions: z.array(ExecutionResultSchema),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** Modifiche dell'avvocato prima dell'approvazione: campi del payload per id azione. */
export const ApprovalRequestSchema = z.object({
  actionIds: z.array(z.string()),
  edits: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Studio e gestionale
// ---------------------------------------------------------------------------

export const StudioProfileSchema = z.object({
  studioName: z.string(),
  lawyerName: z.string(),
  lawyerEmail: z.string(),
  /** Casella dello studio che riceve le trascrizioni. */
  studioEmail: z.string(),
  /** Fuso orario IANA, es. "Europe/Rome". */
  timezone: z.string(),
  /** Link di prenotazione (es. Cal.com) per gli appuntamenti da fissare. */
  bookingLink: z.string().nullable(),
  /** Firma in calce alle email. */
  signature: z.string(),
});
export type StudioProfile = z.infer<typeof StudioProfileSchema>;

export const ClientSchema = z.object({
  id: z.string(),
  kind: z.enum(["persona_fisica", "persona_giuridica"]),
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  companyName: z.string().nullable(),
  taxCode: z.string().nullable(),
  vatNumber: z.string().nullable(),
  email: z.string().nullable(),
  pec: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
});
export type Client = z.infer<typeof ClientSchema>;

export const MatterNoteSchema = z.object({
  id: z.string(),
  at: z.string(),
  author: z.string(),
  kind: z.enum(["incarico", "accordo_economico", "documenti", "attivita", "nota"]),
  text: z.string(),
  sourceRecordingId: z.string().nullable(),
});
export type MatterNote = z.infer<typeof MatterNoteSchema>;

export const MatterSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  /** Numero di pratica, es. "2026/134". */
  number: z.string(),
  title: z.string(),
  status: z.enum(["aperta", "in_valutazione", "chiusa"]),
  openedAt: z.string(),
  notes: z.array(MatterNoteSchema),
});
export type Matter = z.infer<typeof MatterSchema>;

export const CaseManagementDataSchema = z.object({
  clients: z.array(ClientSchema),
  matters: z.array(MatterSchema),
});
export type CaseManagementData = z.infer<typeof CaseManagementDataSchema>;
