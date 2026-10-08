/**
 * Esecutori delle azioni approvate: eventi di calendario e bozze email
 * (depositati dall'ufficio: file .ics/.eml nell'outbox oppure Microsoft 365),
 * pratiche e note nel gestionale.
 */
import {
  formatDuration,
  formatItalianDate,
  formatItalianDateTime,
  formatTimestamp,
  isLocalDate,
  isLocalDateTime,
  localDateOf,
} from "../domain/time.js";
import type {
  ActionPayload,
  Client,
  ClientMatch,
  ExecutionArtifact,
  ExecutionResult,
  Matter,
  ParticipantRole,
  ProposalParticipant,
  ProposedAction,
  StudioProfile,
} from "../domain/types.js";
import {
  CLIENT_LINK_MIN_SCORE,
  clientForName,
  linkableMatch,
  namesCompatible,
  strongestMatch,
} from "../enrich/client-link.js";
import { isEmailAddress, type EmlAddress } from "./eml.js";
import type { ActionExecutor, ExecutionContext } from "./executor.js";
import {
  CONVERSATION_LABELS,
  ROLE_LABELS,
  describeAction,
  formatLocalDate,
  formatLocalDateTime,
  normalizeForComparison,
} from "./format.js";
import { FileOffice, type MessageSpec, type Office, type OfficeTarget } from "./office.js";

type PayloadOf<T extends ActionPayload["type"]> = Extract<ActionPayload, { type: T }>;
type CaseManagementType = "incarico" | "accordo_economico" | "documenti" | "attivita";

interface Outcome {
  status: ExecutionResult["status"];
  message: string;
  artifacts: ExecutionArtifact[];
}

const CLIENT_ROLES: ReadonlySet<ParticipantRole> = new Set(["cliente", "potenziale_cliente"]);
const DEFAULT_APPOINTMENT_MINUTES = 60;
/** Durata delle scadenze con orario. */
const DEFAULT_DEADLINE_MINUTES = 60;
/** Promemoria dal più importante: Outlook ne usa uno solo (il primo), il file .ics tutti. */
const APPOINTMENT_ALARMS = [60, 1440];
const DEADLINE_ALARMS = [10080, 1440];
const NOTE_AUTHOR = "Seguito";

/** Particelle che aprono un cognome composto ("De Luca", "Della Valle"). */
const SURNAME_PARTICLES: ReadonlySet<string> = new Set(
  "de di da del della dello dei degli delle dal dalla lo la li".split(" "),
);
/** Titoli ignorati nel separare nome e cognome (confrontati senza punti). */
const HONORIFICS: ReadonlySet<string> = new Set(
  "sig sigra signor signora dott dottssa avv ing geom rag prof".split(" "),
);

/** Esecutori di tutte le azioni; eventi e bozze vanno all'ufficio indicato (predefinito: file nell'outbox). */
export function defaultExecutors(office: Office = new FileOffice()): ActionExecutor[] {
  return [
    executor("calendario-appuntamenti", ["appuntamento"], office, executeAppointment),
    executor("calendario-scadenze", ["scadenza"], office, executeDeadline),
    executor("bozze-email", ["email"], office, executeEmail),
    executor("invio-trascrizione", ["invio_trascrizione"], office, executeTranscript),
    executor(
      "gestionale",
      ["incarico", "accordo_economico", "documenti", "attivita"],
      office,
      executeCaseManagement,
    ),
  ];
}

function executor<T extends ActionPayload["type"]>(
  name: string,
  types: readonly T[],
  office: Office,
  run: (action: ProposedAction, payload: PayloadOf<T>, ctx: ExecutionContext, office: Office) => Promise<Outcome>,
): ActionExecutor {
  const handles = (payload: ActionPayload): payload is PayloadOf<T> =>
    (types as readonly string[]).includes(payload.type);
  return {
    name,
    canHandle: (action) => handles(action.payload),
    async execute(action, ctx) {
      const outcome = handles(action.payload)
        ? await run(action, action.payload, ctx, office)
        : failure(`Azione di tipo «${action.payload.type}» non gestita dall'esecutore «${name}».`);
      return { actionId: action.id, executedAt: ctx.now.toISOString(), ...outcome };
    },
  };
}

// ---------------------------------------------------------------------------
// Appuntamenti
// ---------------------------------------------------------------------------

async function executeAppointment(
  action: ProposedAction,
  p: PayloadOf<"appuntamento">,
  ctx: ExecutionContext,
  office: Office,
): Promise<Outcome> {
  // Una data e ora indicate (anche dall'avvocato) prevalgono sullo stato «da fissare».
  if (p.start === null && p.status === "da_fissare") return schedulingDraft(action, p, ctx, office);
  if (p.start === null || !isLocalDateTime(p.start)) {
    return failure("Data e ora dell'appuntamento mancanti o non valide: indicarle e approvare di nuovo.");
  }
  const artifact = await office.createEvent(
    {
      label: `Evento: ${p.title}`,
      stem: p.title,
      title: p.title,
      description: appointmentDescription(p, ctx),
      location: p.location ?? modeLocation(p.mode, ctx.studio),
      start: p.start,
      allDayDate: null,
      durationMinutes:
        p.durationMinutes !== null && p.durationMinutes > 0 ? p.durationMinutes : DEFAULT_APPOINTMENT_MINUTES,
      remindersMinutesBefore: APPOINTMENT_ALARMS,
      busy: true,
    },
    { ctx, action },
  );
  return success(
    `Evento del ${office.calendarName} creato: ${formatLocalDateTime(p.start, ctx.studio.timezone)}.`,
    [artifact],
  );
}

function appointmentDescription(p: PayloadOf<"appuntamento">, ctx: ExecutionContext): string {
  const participants =
    p.participants.length > 0 ? p.participants.join(", ") : ctx.proposal.participants.map(participantName).join(", ");
  return [
    p.notes ? `Note: ${p.notes}` : null,
    participants ? `Partecipanti: ${participants}` : null,
    `Sintesi della conversazione: ${ctx.proposal.summary}`,
    `Registrazione: «${ctx.recording.title}»`,
    `Generato da Seguito dalla registrazione di ${recordingDateTime(ctx)}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function modeLocation(mode: PayloadOf<"appuntamento">["mode"], studio: StudioProfile): string | null {
  switch (mode) {
    case "in_studio":
      return studio.studioName;
    case "telefonico":
      return "Appuntamento telefonico";
    case "videochiamata":
      return "Videochiamata";
    default:
      return null;
  }
}

/**
 * Appuntamento da fissare: bozza al cliente per concordare data e ora, salvo
 * che lo faccia già un'email approvata allo stesso cliente o che il cliente non
 * sia tra i partecipanti. In quei casi l'azione resta da completare con la data.
 */
async function schedulingDraft(
  action: ProposedAction,
  p: PayloadOf<"appuntamento">,
  ctx: ExecutionContext,
  office: Office,
): Promise<Outcome> {
  const covering = coveringClientEmail(ctx);
  if (covering !== null) {
    return skipped(
      `Nessuna bozza separata: la richiesta di fissare l'appuntamento è nell'email «${covering.subject}». ` +
        `${SCHEDULE_LATER}`,
    );
  }
  const clients = clientParticipants(ctx.proposal.participants);
  if (!involvesClient(p, clients)) {
    return skipped(`Il cliente non partecipa all'appuntamento: nessuna bozza al cliente. ${SCHEDULE_LATER}`);
  }
  const recipient = clientRecipient(ctx.proposal.participants);
  const greetingName = recipient?.name ?? clients.find((x) => x.name)?.name;
  const subject = SCHEDULING_SUBJECTS[p.mode ?? "altro"];
  const text = [
    `Gentile ${greetingName ?? "Cliente"},`,
    "",
    `facendo seguito ${conversationReference(ctx)}, Le scrivo per fissare l'appuntamento di cui abbiamo parlato.`,
    ...modeSentence(p),
    ctx.studio.bookingLink
      ? `Per Sua comodità, può scegliere data e ora qui: ${ctx.studio.bookingLink}`
      : "La prego di indicarmi alcune date e fasce orarie in cui sarebbe disponibile, così da poter fissare l'incontro.",
    "",
    "Resto a disposizione per qualsiasi chiarimento.",
    "",
    "Cordiali saluti.",
    "",
    ctx.studio.signature,
  ].join("\n");
  const artifact = await draft(office, { ctx, action }, { subject, to: recipient === null ? [] : [recipient], text });
  const created = `Bozza email per fissare l'appuntamento creata${office.draftPlace}`;
  return success(
    recipient === null
      ? `${created} senza destinatario: aggiungerlo prima dell'invio.`
      : `${created} (destinatario: ${recipient.name ?? recipient.email}).`,
    [artifact],
  );
}

const SCHEDULE_LATER =
  "Quando la data sarà concordata, indicarla nel campo «Data e ora» e approvare di nuovo per creare l'evento.";

/** Oggetto neutro: niente titolo interno né materia della pratica. */
const SCHEDULING_SUBJECTS: Record<NonNullable<PayloadOf<"appuntamento">["mode"]>, string> = {
  in_studio: "Appuntamento presso lo studio",
  telefonico: "Appuntamento telefonico",
  videochiamata: "Appuntamento in videochiamata",
  altro: "Appuntamento",
};

/**
 * Email al cliente, approvata ora o già eseguita, che parla dell'appuntamento
 * (o contiene il link di prenotazione): rende superflua una seconda bozza.
 */
function coveringClientEmail(ctx: ExecutionContext): PayloadOf<"email"> | null {
  const done = new Set(ctx.proposal.executions.filter((e) => e.status === "ok").map((e) => e.actionId));
  for (const a of ctx.proposal.actions) {
    if (a.payload.type !== "email" || !CLIENT_ROLES.has(a.payload.recipientRole)) continue;
    if (!ctx.approvedActionIds.has(a.id) && !done.has(a.id)) continue;
    const body = normalizeForComparison(a.payload.body);
    const mentionsBooking = ctx.studio.bookingLink !== null && a.payload.body.includes(ctx.studio.bookingLink);
    if (mentionsBooking || /\b(?:appuntament|incontr)/.test(body)) return a.payload;
  }
  return null;
}

/** Senza partecipanti indicati l'appuntamento si intende con il cliente. */
function involvesClient(p: PayloadOf<"appuntamento">, clients: ProposalParticipant[]): boolean {
  if (p.participants.length === 0) return clients.length > 0;
  return p.participants.some((name) =>
    clients.some((c) => [c.name, c.clientMatch?.displayName].some((own) => namesCompatible(own, name))),
  );
}

function conversationReference(ctx: ExecutionContext): string {
  const date = recordingDate(ctx);
  switch (ctx.proposal.conversationType) {
    case "telefonata":
      return `alla nostra telefonata di ${date}`;
    case "riunione_in_presenza":
      return `al nostro incontro di ${date}`;
    case "videochiamata":
      return `alla nostra videochiamata di ${date}`;
    case "non_determinabile":
      return `al nostro colloquio di ${date}`;
  }
}

function modeSentence(p: PayloadOf<"appuntamento">): string[] {
  switch (p.mode) {
    case "in_studio":
      return [`L'incontro si terrà presso lo studio${p.location ? ` (${p.location})` : ""}.`];
    case "telefonico":
      return ["Il colloquio si svolgerà telefonicamente."];
    case "videochiamata":
      return ["Il colloquio si svolgerà in videochiamata: Le invieremo il collegamento una volta fissata la data."];
    default:
      return [];
  }
}

/** Destinatario: il cliente collegato al gestionale con l'email, altrimenti l'email detta in chiamata. */
function clientRecipient(participants: ProposalParticipant[]): EmlAddress | null {
  const clients = clientParticipants(participants);
  const matched = strongestMatch(
    clients.flatMap((x) => {
      const match = linkedMatch(x);
      return match?.email && isEmailAddress(match.email) ? [match] : [];
    }),
  );
  if (matched?.email) return { name: matched.displayName, email: matched.email.trim() };
  const spoken = clients.find((x) => x.email !== null && isEmailAddress(x.email));
  return spoken?.email ? { name: spoken.name, email: spoken.email.trim() } : null;
}

// ---------------------------------------------------------------------------
// Scadenze
// ---------------------------------------------------------------------------

async function executeDeadline(
  action: ProposedAction,
  p: PayloadOf<"scadenza">,
  ctx: ExecutionContext,
  office: Office,
): Promise<Outcome> {
  if (p.date === null || !isLocalDate(p.date)) {
    return failure("Data della scadenza mancante o non valida: indicarla e approvare di nuovo.");
  }
  const start = p.time !== null && isLocalDateTime(`${p.date}T${p.time}`) ? `${p.date}T${p.time}` : null;
  const artifact = await office.createEvent(
    {
      label: `Scadenza: ${p.title}`,
      stem: p.title,
      // I termini processuali sono sempre da verificare: lo si vede anche dall'elenco del calendario.
      title: `Scadenza: ${p.title}${p.kind === "processuale" ? " (da verificare)" : ""}`,
      description: [
        ...describeAction(p, ctx.studio.timezone).lines.slice(1),
        verificationLine(p),
        `Registrazione: «${ctx.recording.title}»`,
        `Generato da Seguito dalla registrazione di ${recordingDateTime(ctx)}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      location: null,
      start,
      allDayDate: p.date,
      durationMinutes: DEFAULT_DEADLINE_MINUTES,
      remindersMinutesBefore: DEADLINE_ALARMS,
      busy: false,
    },
    { ctx, action },
  );
  const when = `${formatItalianDate(p.date)}${start === null ? "" : `, ore ${p.time}`}`;
  const ignoredTime =
    p.time !== null && start === null ? " L'orario indicato non è valido: evento sull'intera giornata." : "";
  return success(`Scadenza inserita nel ${office.calendarName}: ${when}.${ignoredTime}`, [artifact]);
}

function verificationLine(p: PayloadOf<"scadenza">): string | null {
  if (p.computation !== null) return "Termine calcolato automaticamente: verificarne il calcolo.";
  return p.kind === "processuale" ? "Data da verificare sul fascicolo." : null;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function executeEmail(
  action: ProposedAction,
  p: PayloadOf<"email">,
  ctx: ExecutionContext,
  office: Office,
): Promise<Outcome> {
  const email = p.recipientEmail?.trim() || null;
  const to = email === null ? [] : [{ name: p.recipientName?.trim() || null, email }];
  const artifact = await draft(
    office,
    { ctx, action },
    { subject: p.subject, to, text: `${p.body.trimEnd()}\n\n${ctx.studio.signature}` },
  );
  const created = `Bozza creata${office.draftPlace}`;
  return success(email === null ? `${created} senza destinatario: aggiungerlo prima dell'invio.` : `${created}.`, [
    artifact,
  ]);
}

// ---------------------------------------------------------------------------
// Trascrizione allo studio
// ---------------------------------------------------------------------------

async function executeTranscript(
  action: ProposedAction,
  p: PayloadOf<"invio_trascrizione">,
  ctx: ExecutionContext,
  office: Office,
): Promise<Outcome> {
  const { recording } = ctx;
  const subject = `Trascrizione – ${recording.title} – ${recordingDate(ctx)}`;
  const transcript = transcriptLines(ctx).join("\n");
  const header = `${recording.title}\n${recordingDateTime(ctx)} – durata ${formatDuration(recording.durationMs)}`;
  const to = p.to.trim() === "" ? [] : [{ name: null, email: p.to.trim() }];
  const { artifact, sent } = await office.deliverToStudio(
    {
      label: `Bozza email: ${subject}`,
      to,
      subject,
      text: transcriptBody(ctx, transcript),
      attachments: [
        {
          filename: "trascrizione.txt",
          contentType: "text/plain; charset=utf-8",
          content: `${header}\n\n${transcript}\n`,
        },
      ],
    },
    { ctx, action },
  );
  if (sent) return success(`Trascrizione inviata a ${p.to.trim()}.`, [artifact]);
  return success(
    to.length === 0
      ? `Bozza con la trascrizione creata${office.draftPlace} senza destinatario: aggiungerlo prima dell'invio.`
      : `Bozza con la trascrizione per ${p.to.trim()} creata${office.draftPlace}.`,
    [artifact],
  );
}

function transcriptLines(ctx: ExecutionContext): string[] {
  return [...ctx.recording.segments]
    .sort((a, b) => a.index - b.index)
    .map((s) => `[${formatTimestamp(s.startMs)}] ${s.speaker}: ${s.text}`);
}

function transcriptBody(ctx: ExecutionContext, transcript: string): string {
  const { proposal, recording } = ctx;
  const actions = proposal.actions
    .filter((a) => a.payload.type !== "invio_trascrizione")
    .map((a) => {
      const { label, lines } = describeAction(a.payload, ctx.studio.timezone);
      return `- ${label}: ${lines[0] ?? ""}`;
    });
  const sections: Array<[string, string[]]> = [
    ["SINTESI", [proposal.summary]],
    ["PARTECIPANTI", proposal.participants.map(participantLine)],
    ["AZIONI PROPOSTE", actions.length > 0 ? actions : ["Nessuna azione proposta."]],
    ["AVVISI", proposal.warnings.map((w) => `- ${w.message}`)],
    ["PUNTI DA CHIARIRE", proposal.doubts.map((d) => `- ${d.text}`)],
    ["TRASCRIZIONE", [transcript || "Trascrizione non disponibile."]],
  ];
  return [
    `Trascrizione della registrazione «${recording.title}».`,
    "",
    `Data: ${recordingDateTime(ctx)}`,
    `Durata: ${formatDuration(recording.durationMs)}`,
    `Tipo di conversazione: ${CONVERSATION_LABELS[proposal.conversationType]}`,
    ...sections.filter(([, lines]) => lines.length > 0).flatMap(([title, lines]) => ["", title, ...lines]),
    "",
    "Messaggio generato da Seguito.",
  ].join("\n");
}

function participantLine(p: ProposalParticipant): string {
  const role = `${ROLE_LABELS[p.role]}${p.organization ? `, ${p.organization}` : ""}`;
  const speaker = p.speakerLabel ? ` – ${p.speakerLabel}` : "";
  const match = p.clientMatch ? ` – nel gestionale: ${p.clientMatch.displayName}` : "";
  return `- ${p.name ?? "Nome non indicato"} (${role})${speaker}${match}`;
}

// ---------------------------------------------------------------------------
// Gestionale: incarichi, accordi economici, documenti, attività
// ---------------------------------------------------------------------------

async function executeCaseManagement(
  _action: ProposedAction,
  p: PayloadOf<CaseManagementType>,
  ctx: ExecutionContext,
): Promise<Outcome> {
  const artifacts: ExecutionArtifact[] = [];
  const messages: string[] = [];
  let client = await findClient(p, ctx);
  if (client === null) {
    if (p.type !== "incarico") {
      return failure(
        "Cliente non presente nel gestionale: approvare anche l'incarico (che crea l'anagrafica) " +
          "oppure registrare la nota manualmente.",
      );
    }
    if (p.status === "non_conferito") {
      return skipped("Incarico non conferito e cliente non presente nel gestionale: nessuna registrazione effettuata.");
    }
    client = await createClientFor(p, ctx);
    if (client === null) {
      return failure("Nome del cliente mancante: indicarlo nel campo «Cliente» e approvare di nuovo.");
    }
    artifacts.push({ kind: "gestionale", label: `Nuovo cliente: ${client.displayName}`, path: null, ref: client.id });
    messages.push(`Nuovo cliente ${client.displayName} inserito nel gestionale.`);
  }

  const target = await targetMatter(p, client, ctx);
  if (target === null) {
    return skipped(`Incarico non conferito e nessuna pratica di ${client.displayName}: nessuna nota registrata.`);
  }
  const { matter, created } = target;
  if (created) {
    artifacts.push({
      kind: "gestionale",
      label: `Nuova pratica ${matter.number} – ${matter.title}`,
      path: null,
      ref: matter.id,
    });
    const opened = matter.status === "aperta" ? "aperta" : "creata in valutazione";
    messages.push(`Pratica ${matter.number} «${matter.title}» ${opened} per ${client.displayName}.`);
  }
  const note = await ctx.caseManagement.addMatterNote(matter.id, {
    author: NOTE_AUTHOR,
    kind: p.type,
    text: noteText(p, ctx),
    sourceRecordingId: ctx.proposal.recordingId,
  });
  artifacts.push({ kind: "gestionale", label: `Nota nella pratica ${matter.number}`, path: null, ref: note.id });
  messages.push(`Nota registrata nella pratica ${matter.number} (${client.displayName}).`);
  return success(messages.join(" "), artifacts);
}

/**
 * Cliente dell'azione. Il nome indicato negli incarichi (eventualmente corretto
 * dall'avvocato nel campo «Cliente») prevale sul collegamento del partecipante,
 * che vale solo se compatibile con quel nome; per l'incarico, un nome senza
 * corrispondenza sicura significa un cliente nuovo. Poi il partecipante
 * collegato e infine la ricerca per nome, email e telefono.
 */
async function findClient(p: PayloadOf<CaseManagementType>, ctx: ExecutionContext): Promise<Client | null> {
  const cm = ctx.caseManagement;
  const clients = clientParticipants(ctx.proposal.participants);
  const linked = strongestMatch(clients.flatMap((x) => linkedMatch(x) ?? []));
  for (const name of engagementClientNames(p, ctx)) {
    const match = clientForName(await cm.findClients({ name }), linked);
    const client = match === null ? null : await cm.getClient(match.clientId);
    if (client !== null) return client;
    if (p.type === "incarico") return null;
  }
  if (linked !== null) {
    const client = await cm.getClient(linked.clientId);
    if (client !== null) return client;
  }
  // Il cliente può essere stato creato da un'azione precedente della stessa approvazione.
  for (const x of clients) {
    if (!x.name && !x.email && !x.phone) continue;
    const match = linkableMatch(await cm.findClients({ name: x.name, email: x.email, phone: x.phone }));
    const client = match === null ? null : await cm.getClient(match.clientId);
    if (client !== null) return client;
  }
  return null;
}

/** Nome del cliente dell'incarico stesso, oppure quelli indicati negli incarichi della proposta. */
function engagementClientNames(p: PayloadOf<CaseManagementType>, ctx: ExecutionContext): string[] {
  const payloads = p.type === "incarico" ? [p] : ctx.proposal.actions.map((a) => a.payload);
  return payloads.flatMap((x) => (x.type === "incarico" && x.clientName?.trim() ? [x.clientName.trim()] : []));
}

/** Collegamento al gestionale abbastanza sicuro da usare (esclude il solo cognome delle proposte meno recenti). */
function linkedMatch(participant: ProposalParticipant): ClientMatch | null {
  const match = participant.clientMatch;
  return match !== null && match.score >= CLIENT_LINK_MIN_SCORE ? match : null;
}

async function createClientFor(p: PayloadOf<"incarico">, ctx: ExecutionContext): Promise<Client | null> {
  const clients = clientParticipants(ctx.proposal.participants);
  const name = p.clientName?.trim() || clients.find((x) => x.name?.trim())?.name?.trim();
  if (!name) return null;
  const wanted = normalizeForComparison(name);
  const source =
    clients.find((x) => x.name !== null && normalizeForComparison(x.name) === wanted) ??
    (clients.length === 1 ? clients[0] : undefined);
  const email = source?.email?.trim();
  return ctx.caseManagement.createClient({
    kind: "persona_fisica",
    displayName: name,
    ...splitPersonName(name),
    companyName: null,
    taxCode: null,
    vatNumber: null,
    email: email && isEmailAddress(email) ? email : null,
    pec: null,
    phone: source?.phone?.trim() || null,
    address: null,
  });
}

/** "Nome Cognome" -> nome e cognome; i cognomi con particella restano uniti ("Maria De Luca"). */
export function splitPersonName(fullName: string): { firstName: string | null; lastName: string | null } {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "" && !HONORIFICS.has(t.toLowerCase().replace(/\./g, "")));
  if (tokens.length === 0) return { firstName: null, lastName: null };
  if (tokens.length === 1) return { firstName: null, lastName: tokens[0] ?? null };
  const particle = tokens.findIndex(
    (t, i) => i > 0 && i < tokens.length - 1 && (SURNAME_PARTICLES.has(t.toLowerCase()) || /^d['’]/i.test(t)),
  );
  const split = particle > 0 ? particle : tokens.length - 1;
  return { firstName: tokens.slice(0, split).join(" "), lastName: tokens.slice(split).join(" ") };
}

async function targetMatter(
  p: PayloadOf<CaseManagementType>,
  client: Client,
  ctx: ExecutionContext,
): Promise<{ matter: Matter; created: boolean } | null> {
  const cm = ctx.caseManagement;
  const matters = (await cm.listMatters(client.id)).sort(
    (a, b) => timeOf(b.openedAt) - timeOf(a.openedAt) || b.id.localeCompare(a.id),
  );
  if (p.type === "incarico") {
    if (p.status === "non_conferito") {
      const latest = matters[0];
      return latest === undefined ? null : { matter: latest, created: false };
    }
    const title = p.subject.trim() || `Incarico – ${ctx.recording.title}`;
    const reusable: ReadonlyArray<Matter["status"]> =
      p.status === "conferito" ? ["aperta"] : ["aperta", "in_valutazione"];
    const same = matters.find(
      (m) => reusable.includes(m.status) && normalizeForComparison(m.title) === normalizeForComparison(title),
    );
    if (same !== undefined) return { matter: same, created: false };
    const status = p.status === "conferito" ? "aperta" : "in_valutazione";
    return { matter: await cm.createMatter({ clientId: client.id, title, status }), created: true };
  }
  const active = matters.find((m) => m.status === "aperta" || m.status === "in_valutazione");
  if (active !== undefined) return { matter: active, created: false };
  const title = `Da classificare – ${ctx.recording.title}`;
  return { matter: await cm.createMatter({ clientId: client.id, title, status: "in_valutazione" }), created: true };
}

function noteText(p: PayloadOf<CaseManagementType>, ctx: ExecutionContext): string {
  const { label, lines } = describeAction(p, ctx.studio.timezone);
  return [
    `${label}: ${lines[0] ?? ""}`,
    ...lines.slice(1),
    `Fonte: registrazione «${ctx.recording.title}» di ${recordingDateTime(ctx)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function success(message: string, artifacts: ExecutionArtifact[]): Outcome {
  return { status: "ok", message, artifacts };
}

function failure(message: string): Outcome {
  return { status: "errore", message, artifacts: [] };
}

function skipped(message: string): Outcome {
  return { status: "saltata", message, artifacts: [] };
}

function clientParticipants(participants: ProposalParticipant[]): ProposalParticipant[] {
  return participants.filter((x) => CLIENT_ROLES.has(x.role));
}

function participantName(p: ProposalParticipant): string {
  return `${p.name ?? "Nome non indicato"} (${ROLE_LABELS[p.role]})`;
}

function recordingStart(ctx: ExecutionContext): Date | null {
  const date = new Date(ctx.recording.startedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Es. "mercoledì 7 ottobre 2026 alle ore 09:30" (fuso dello studio). */
function recordingDateTime(ctx: ExecutionContext): string {
  const start = recordingStart(ctx);
  return start === null ? ctx.recording.startedAt : formatItalianDateTime(start, ctx.studio.timezone);
}

/** Es. "mercoledì 7 ottobre 2026" (fuso dello studio). */
function recordingDate(ctx: ExecutionContext): string {
  const start = recordingStart(ctx);
  return start === null ? ctx.recording.startedAt : formatLocalDate(localDateOf(start, ctx.studio.timezone));
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Bozza dall'ufficio, con l'etichetta usata nell'esito dell'approvazione. */
function draft(office: Office, target: OfficeTarget, message: Omit<MessageSpec, "label">): Promise<ExecutionArtifact> {
  return office.createDraft({ label: `Bozza email: ${message.subject}`, ...message }, target);
}
