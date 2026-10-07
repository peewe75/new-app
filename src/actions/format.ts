/**
 * Testi in italiano usati da note del gestionale, email e calendario,
 * più piccole utilità per nomi di file e confronti di testo.
 */
import {
  formatItalianDate,
  formatItalianDateTime,
  isLocalDate,
  isLocalDateTime,
  zonedLocalToUtc,
} from "../domain/time.js";
import type { ActionPayload, ConversationType, ParticipantRole } from "../domain/types.js";

type PayloadOf<T extends ActionPayload["type"]> = Extract<ActionPayload, { type: T }>;

export interface ActionDescription {
  /** Nome del tipo di azione, es. "Appuntamento". */
  label: string;
  /** La prima riga riassume l'azione; le successive sono dettagli "Campo: valore". */
  lines: string[];
}

export const ACTION_LABELS: Record<ActionPayload["type"], string> = {
  appuntamento: "Appuntamento",
  incarico: "Incarico",
  accordo_economico: "Accordo economico",
  scadenza: "Scadenza",
  documenti: "Documenti",
  email: "Email",
  attivita: "Attività",
  invio_trascrizione: "Invio trascrizione",
};

export const ROLE_LABELS: Record<ParticipantRole, string> = {
  avvocato_studio: "avvocato dello studio",
  cliente: "cliente",
  potenziale_cliente: "potenziale cliente",
  controparte: "controparte",
  collega_avvocato: "collega avvocato",
  consulente: "consulente",
  altro: "altro",
  sconosciuto: "ruolo non determinato",
};

export const CONVERSATION_LABELS: Record<ConversationType, string> = {
  telefonata: "telefonata",
  riunione_in_presenza: "riunione in presenza",
  videochiamata: "videochiamata",
  non_determinabile: "non determinabile",
};

const MODE_LABELS: Record<NonNullable<PayloadOf<"appuntamento">["mode"]>, string> = {
  in_studio: "in studio",
  telefonico: "telefonico",
  videochiamata: "videochiamata",
  altro: "altro",
};

const ENGAGEMENT_STATUS_LABELS: Record<PayloadOf<"incarico">["status"], string> = {
  conferito: "conferito",
  in_valutazione: "in valutazione",
  non_conferito: "non conferito",
};

const FEE_BASIS_LABELS: Record<NonNullable<PayloadOf<"accordo_economico">["basis"]>, string> = {
  forfait: "forfettario",
  orario: "a ore",
  per_fasi: "per fasi",
  percentuale: "a percentuale",
  altro: "altro",
};

const DEADLINE_KIND_LABELS: Record<PayloadOf<"scadenza">["kind"], string> = {
  processuale: "termine processuale",
  contrattuale: "termine contrattuale",
  amministrativa: "termine amministrativo",
  altro: "altro",
};

const AMOUNT = new Intl.NumberFormat("it-IT", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: "always",
});

/** Es. 2500 -> "€ 2.500,00". */
export function formatEuro(n: number): string {
  const abs = AMOUNT.format(Math.abs(n));
  return n < 0 ? `-€ ${abs}` : `€ ${abs}`;
}

/** Importo nella valuta indicata (euro se vuota). */
export function formatAmount(amount: number, currency: string): string {
  const code = currency.trim();
  if (code === "" || code.toUpperCase() === "EUR" || code === "€") return formatEuro(amount);
  return `${AMOUNT.format(amount)} ${code}`;
}

/** Data e ora locali leggibili; il valore grezzo se non valido. */
export function formatLocalDateTime(local: string, timeZone: string): string {
  return isLocalDateTime(local)
    ? formatItalianDateTime(zonedLocalToUtc(local, timeZone), timeZone)
    : `«${local}» (data non valida)`;
}

/** Data locale leggibile; il valore grezzo se non valida. */
export function formatLocalDate(local: string): string {
  return isLocalDate(local) ? formatItalianDate(local) : `«${local}» (data non valida)`;
}

/** Normalizzazione per confronti (stessa regola usata per le citazioni). */
export function normalizeForComparison(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Nome sicuro per file e cartelle: solo [a-z0-9-], massimo 80 caratteri. */
export function safeSlug(s: string): string {
  const slug = s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug === "" ? "senza-nome" : slug;
}

/** Descrizione leggibile di un'azione, per note ed email. */
export function describeAction(payload: ActionPayload, timeZone: string): ActionDescription {
  const label = ACTION_LABELS[payload.type];
  switch (payload.type) {
    case "appuntamento":
      return { label, lines: appointmentLines(payload, timeZone) };
    case "incarico":
      return { label, lines: engagementLines(payload) };
    case "accordo_economico":
      return { label, lines: feeLines(payload) };
    case "scadenza":
      return { label, lines: deadlineLines(payload) };
    case "documenti":
      return { label, lines: documentsLines(payload) };
    case "email":
      return { label, lines: emailLines(payload) };
    case "attivita":
      return { label, lines: taskLines(payload) };
    case "invio_trascrizione":
      return { label, lines: [`Trascrizione da inviare a ${payload.to}`] };
  }
}

/** Righe "Campo: valore" per i soli valori presenti. */
function fields(entries: Array<[string, string | null | undefined]>): string[] {
  return entries.filter((e): e is [string, string] => e[1] != null && e[1].trim() !== "").map(([k, v]) => `${k}: ${v}`);
}

function appointmentLines(p: PayloadOf<"appuntamento">, timeZone: string): string[] {
  const when = p.start === null ? null : formatLocalDateTime(p.start, timeZone);
  const headline =
    p.status === "fissato" ? `${p.title} – ${when ?? "data e ora da definire"}` : `${p.title} – da fissare`;
  return [
    headline,
    ...fields([
      ["Stato", p.status === "fissato" ? "fissato" : "da fissare"],
      ["Data e ora", when],
      ["Durata", p.durationMinutes === null ? null : `${p.durationMinutes} minuti`],
      ["Modalità", p.mode === null ? null : MODE_LABELS[p.mode]],
      ["Luogo", p.location],
      ["Partecipanti", p.participants.join(", ")],
      ["Note", p.notes],
    ]),
  ];
}

function engagementLines(p: PayloadOf<"incarico">): string[] {
  return [
    `${p.subject} – incarico ${ENGAGEMENT_STATUS_LABELS[p.status]}`,
    ...fields([
      ["Cliente", p.clientName],
      ["Materia", p.matterType],
      ["Controparte", p.counterpart],
      ["Urgenza", p.urgency],
      ["Note", p.notes],
    ]),
  ];
}

function feeLines(p: PayloadOf<"accordo_economico">): string[] {
  const amount = p.amount === null ? null : `${formatAmount(p.amount, p.currency)}${vatSuffix(p.plusVatAndCpa)}`;
  const status = p.agreed ? "concordato" : "proposto, non ancora concordato";
  return [
    `${p.description}${amount === null ? "" : ` – ${amount}`} (${status})`,
    ...fields([
      ["Stato", status],
      ["Importo", amount],
      ["Criterio", p.basis === null ? null : FEE_BASIS_LABELS[p.basis]],
      ["Tariffa oraria", p.hourlyRate === null ? null : `${formatAmount(p.hourlyRate, p.currency)} l'ora`],
      ["Acconto", p.advanceAmount === null ? null : formatAmount(p.advanceAmount, p.currency)],
      ["Pagamento", p.paymentTerms],
    ]),
  ];
}

function vatSuffix(plusVatAndCpa: boolean | null): string {
  if (plusVatAndCpa === null) return "";
  return plusVatAndCpa ? " oltre IVA e CPA" : " comprensivo di IVA e CPA";
}

function deadlineLines(p: PayloadOf<"scadenza">): string[] {
  const when =
    p.date === null ? "data da definire" : `${formatLocalDate(p.date)}${p.time === null ? "" : `, ore ${p.time}`}`;
  return [
    `${p.title} – ${when}`,
    ...fields([
      ["Tipo", DEADLINE_KIND_LABELS[p.kind]],
      ["Riferimento normativo", p.legalBasis],
      ["Calcolo", p.computation],
      ["Note", p.notes],
    ]),
  ];
}

function documentsLines(p: PayloadOf<"documenti">): string[] {
  const receiving = p.direction === "da_ricevere";
  const who = p.counterpartName === null ? "" : `${receiving ? " da" : " a"} ${p.counterpartName}`;
  const due = p.dueDate === null ? "" : ` entro ${formatLocalDate(p.dueDate)}`;
  return [`Documenti ${receiving ? "da ricevere" : "da inviare"}${who}${due}`, ...p.items.map((item) => `- ${item}`)];
}

function emailLines(p: PayloadOf<"email">): string[] {
  const email = p.recipientEmail?.trim() || null;
  const name = p.recipientName?.trim() || null;
  const recipient =
    name !== null && email !== null ? `${name} <${email}>` : (name ?? email ?? "destinatario da completare");
  return [`A ${recipient}: «${p.subject}»`, ...fields([["Scopo", p.purpose]])];
}

function taskLines(p: PayloadOf<"attivita">): string[] {
  return [
    p.description,
    ...fields([
      ["Incaricato", p.assignee],
      ["Entro", p.dueDate === null ? null : formatLocalDate(p.dueDate)],
    ]),
  ];
}
