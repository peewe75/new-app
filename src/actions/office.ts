/**
 * Dove finiscono eventi e bozze: file .ics/.eml nell'outbox (predefinito)
 * oppure un servizio collegato, come Microsoft 365. Gli esecutori preparano il
 * contenuto; l'ufficio lo deposita e restituisce il riferimento da mostrare.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExecutionArtifact, ProposedAction } from "../domain/types.js";
import { writeFileAtomic } from "../store/json-store.js";
import { buildEml, type EmlAddress, type EmlAttachment } from "./eml.js";
import type { ExecutionContext } from "./executor.js";
import { safeSlug } from "./format.js";
import { buildIcsEvent } from "./ics.js";

export interface CalendarEventSpec {
  /** Testo mostrato nell'esito dell'approvazione, es. "Scadenza: …". */
  label: string;
  /** Nome breve da cui ricavare il nome del file. */
  stem: string;
  title: string;
  description: string;
  location: string | null;
  /** "YYYY-MM-DDTHH:mm" nel fuso dello studio; null per un evento sull'intera giornata. */
  start: string | null;
  /** "YYYY-MM-DD": giorno dell'evento quando manca l'orario. */
  allDayDate: string | null;
  durationMinutes: number;
  /** Promemoria in minuti prima dell'inizio, dal più importante. */
  remindersMinutesBefore: number[];
  /** true se l'evento occupa il tempo in agenda (appuntamenti), false per le scadenze. */
  busy: boolean;
}

export interface MessageSpec {
  /** Testo mostrato nell'esito dell'approvazione, es. "Bozza email: …". */
  label: string;
  to: EmlAddress[];
  subject: string;
  text: string;
  attachments?: EmlAttachment[];
}

export interface OfficeTarget {
  ctx: ExecutionContext;
  action: ProposedAction;
}

export interface Delivery {
  artifact: ExecutionArtifact;
  /** true se il messaggio è stato inviato, false se è rimasto una bozza. */
  sent: boolean;
}

export interface Office {
  readonly name: string;
  /** Come chiamare il calendario nei messaggi: "calendario" o "calendario Outlook". */
  readonly calendarName: string;
  /** Precisazione aggiunta a «Bozza creata»: "" oppure " in Outlook". */
  readonly draftPlace: string;
  createEvent(spec: CalendarEventSpec, target: OfficeTarget): Promise<ExecutionArtifact>;
  createDraft(spec: MessageSpec, target: OfficeTarget): Promise<ExecutionArtifact>;
  /** Messaggio per la casella dello studio: bozza, oppure invio se l'ufficio è configurato per farlo. */
  deliverToStudio(spec: MessageSpec, target: OfficeTarget): Promise<Delivery>;
}

/**
 * Errore di un servizio collegato con un messaggio in italiano già adatto
 * all'avvocato (nessun dettaglio tecnico né dato personale).
 */
export class ConnectorError extends Error {
  override name = "ConnectorError";
}

/** File .ics ed .eml nella cartella outbox, una sottocartella per proposta. */
export class FileOffice implements Office {
  readonly name = "file";
  readonly calendarName = "calendario";
  readonly draftPlace = "";

  async createEvent(spec: CalendarEventSpec, { ctx, action }: OfficeTarget): Promise<ExecutionArtifact> {
    const ics = buildIcsEvent({
      uid: `${safeSlug(ctx.proposal.id)}-${safeSlug(action.id)}@seguito`,
      title: spec.title,
      description: spec.description,
      location: spec.location,
      start: spec.start,
      ...(spec.allDayDate === null ? {} : { allDayDate: spec.allDayDate }),
      durationMinutes: spec.durationMinutes,
      timezone: ctx.studio.timezone,
      alarmsMinutesBefore: spec.remindersMinutesBefore,
      now: ctx.now,
    });
    const path = await writeOutboxFile(ctx, action, spec.stem, "ics", ics);
    return { kind: "ics", label: spec.label, path, ref: null };
  }

  async createDraft(spec: MessageSpec, { ctx, action }: OfficeTarget): Promise<ExecutionArtifact> {
    const eml = buildEml({
      from: { name: ctx.studio.lawyerName, email: ctx.studio.lawyerEmail },
      to: spec.to,
      subject: spec.subject,
      text: spec.text,
      date: ctx.now,
      messageId: `${randomUUID()}@seguito.local`,
      ...(spec.attachments === undefined ? {} : { attachments: spec.attachments }),
    });
    const path = await writeOutboxFile(ctx, action, spec.subject, "eml", eml);
    return { kind: "eml", label: spec.label, path, ref: null };
  }

  async deliverToStudio(spec: MessageSpec, target: OfficeTarget): Promise<Delivery> {
    return { artifact: await this.createDraft(spec, target), sent: false };
  }
}

/** Scrive il file nella cartella della proposta; restituisce il percorso relativo all'outbox. */
async function writeOutboxFile(
  ctx: ExecutionContext,
  action: ProposedAction,
  name: string,
  extension: "ics" | "eml",
  content: string,
): Promise<string> {
  const dir = safeSlug(ctx.proposal.id);
  const fileName = `${safeSlug(action.id)}-${safeSlug(name)}.${extension}`;
  await writeFileAtomic(join(ctx.outboxDir, dir, fileName), content);
  return `${dir}/${fileName}`;
}
