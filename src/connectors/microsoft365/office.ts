/**
 * Microsoft 365 come ufficio di Seguito: eventi nel calendario Outlook e bozze
 * nella cartella Bozze dell'account collegato (Microsoft Graph). Nessuna email
 * parte verso l'esterno: l'unico invio possibile è quello della trascrizione
 * alla casella dello studio, e solo se configurato (SEGUITO_TRASCRIZIONE=invio).
 */
import { createHash } from "node:crypto";
import { zonedLocalToUtc } from "../../domain/time.js";
import type { ExecutionArtifact } from "../../domain/types.js";
import type { EmlAddress, EmlAttachment } from "../../actions/eml.js";
import {
  ConnectorError,
  type CalendarEventSpec,
  type Delivery,
  type MessageSpec,
  type Office,
  type OfficeTarget,
} from "../../actions/office.js";
import type { GraphClient } from "./graph.js";

export interface Microsoft365OfficeOptions {
  graph: GraphClient;
  /** Trascrizione alla casella dello studio: bozza oppure invio diretto. */
  transcriptDelivery: "bozza" | "invio";
}

/** Limite di Graph per gli allegati inviati insieme al messaggio (3 MB). */
const MAX_INLINE_ATTACHMENTS_BYTES = 3 * 1024 * 1024;
const CATEGORY = "Seguito";

/**
 * Fusi orari di Windows usati da Exchange per gli eventi sull'intera giornata,
 * che devono iniziare e finire a mezzanotte nel fuso dello studio.
 */
const WINDOWS_TIME_ZONES: Readonly<Record<string, string>> = {
  "Europe/Rome": "W. Europe Standard Time",
  "Europe/Vatican": "W. Europe Standard Time",
  "Europe/San_Marino": "W. Europe Standard Time",
  "Europe/Malta": "W. Europe Standard Time",
  "Europe/Berlin": "W. Europe Standard Time",
  "Europe/Vienna": "W. Europe Standard Time",
  "Europe/Zurich": "W. Europe Standard Time",
  "Europe/Amsterdam": "W. Europe Standard Time",
  "Europe/Paris": "Romance Standard Time",
  "Europe/Brussels": "Romance Standard Time",
  "Europe/Madrid": "Romance Standard Time",
  "Europe/London": "GMT Standard Time",
  UTC: "UTC",
};

interface GraphItem {
  id: string | null;
  webLink: string | null;
}

export class Microsoft365Office implements Office {
  readonly name = "microsoft365";
  readonly calendarName = "calendario Outlook";
  readonly draftPlace = " in Outlook";

  constructor(private readonly opts: Microsoft365OfficeOptions) {}

  async createEvent(spec: CalendarEventSpec, { ctx, action }: OfficeTarget): Promise<ExecutionArtifact> {
    const timeZone = ctx.studio.timezone;
    const reminder = spec.remindersMinutesBefore[0];
    const body = {
      subject: spec.title,
      body: { contentType: "text", content: spec.description },
      ...eventTimes(spec, timeZone),
      ...(spec.location === null ? {} : { location: { displayName: spec.location } }),
      showAs: spec.busy ? "busy" : "free",
      isReminderOn: reminder !== undefined,
      ...(reminder === undefined ? {} : { reminderMinutesBeforeStart: reminder }),
      categories: [CATEGORY],
      // Stesso identificativo per gli stessi dati: un nuovo tentativo non crea un doppione.
      transactionId: transactionId(ctx.proposal.id, action.id, spec),
    };
    const item = graphItem(await this.opts.graph.request("POST", "/me/events", body));
    return { kind: "evento_calendario", label: spec.label, path: null, ref: item.id, url: item.webLink };
  }

  async createDraft(spec: MessageSpec): Promise<ExecutionArtifact> {
    const item = graphItem(await this.opts.graph.request("POST", "/me/messages", graphMessage(spec)));
    return { kind: "bozza_email", label: spec.label, path: null, ref: item.id, url: item.webLink };
  }

  async deliverToStudio(spec: MessageSpec, target: OfficeTarget): Promise<Delivery> {
    if (this.opts.transcriptDelivery !== "invio" || !onlyStudioMailbox(spec.to, target.ctx.studio.studioEmail)) {
      return { artifact: await this.createDraft(spec), sent: false };
    }
    await this.opts.graph.request("POST", "/me/sendMail", { message: graphMessage(spec), saveToSentItems: true });
    return {
      artifact: { kind: "email_inviata", label: `Email inviata: ${spec.subject}`, path: null, ref: null, url: null },
      sent: true,
    };
  }
}

/**
 * Orari dell'evento. Con orario: istante UTC (Outlook lo mostra nel fuso
 * dell'utente). Intera giornata: da mezzanotte a mezzanotte nel fuso dello
 * studio, come richiede Exchange.
 */
function eventTimes(spec: CalendarEventSpec, timeZone: string): Record<string, unknown> {
  if (spec.start !== null) {
    const start = zonedLocalToUtc(spec.start, timeZone);
    const end = new Date(start.getTime() + spec.durationMinutes * 60_000);
    return {
      start: { dateTime: utcDateTime(start), timeZone: "UTC" },
      end: { dateTime: utcDateTime(end), timeZone: "UTC" },
      isAllDay: false,
    };
  }
  if (spec.allDayDate === null) throw new ConnectorError("Evento senza data: indicarla e approvare di nuovo.");
  const zone = WINDOWS_TIME_ZONES[timeZone] ?? timeZone;
  return {
    start: { dateTime: `${spec.allDayDate}T00:00:00`, timeZone: zone },
    end: { dateTime: `${nextDay(spec.allDayDate)}T00:00:00`, timeZone: zone },
    isAllDay: true,
  };
}

function graphMessage(spec: MessageSpec): Record<string, unknown> {
  const attachments = spec.attachments ?? [];
  const fits = attachments.reduce((sum, a) => sum + base64Length(a.content), 0) <= MAX_INLINE_ATTACHMENTS_BYTES;
  const omitted = fits ? "" : `\n\n(Allegati omessi perché superano il limite di 3 MB di Microsoft 365: il testo completo è qui sopra.)`;
  return {
    subject: spec.subject,
    body: { contentType: "text", content: `${spec.text}${omitted}` },
    toRecipients: spec.to.map(recipient),
    ...(fits && attachments.length > 0 ? { attachments: attachments.map(fileAttachment) } : {}),
  };
}

function recipient(address: EmlAddress): Record<string, unknown> {
  return { emailAddress: { address: address.email, ...(address.name ? { name: address.name } : {}) } };
}

function fileAttachment(a: EmlAttachment): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.contentType,
    contentBytes: Buffer.from(a.content, "utf8").toString("base64"),
  };
}

/** L'invio diretto è ammesso solo verso la casella dello studio, e solo verso quella. */
function onlyStudioMailbox(to: readonly EmlAddress[], studioEmail: string): boolean {
  const studio = studioEmail.trim().toLowerCase();
  return studio !== "" && to.length === 1 && to[0]?.email.trim().toLowerCase() === studio;
}

function graphItem(response: unknown): GraphItem {
  const value = typeof response === "object" && response !== null ? (response as Record<string, unknown>) : {};
  return {
    id: typeof value.id === "string" ? value.id : null,
    webLink: typeof value.webLink === "string" && value.webLink.startsWith("https://") ? value.webLink : null,
  };
}

function transactionId(proposalId: string, actionId: string, spec: CalendarEventSpec): string {
  const hex = createHash("sha256").update(JSON.stringify([proposalId, actionId, spec])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** "YYYY-MM-DDTHH:mm:ss" in UTC. */
function utcDateTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function nextDay(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

function base64Length(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3) * 4;
}
