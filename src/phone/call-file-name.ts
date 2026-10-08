/**
 * Informazioni ricavabili dal nome dei file delle chiamate registrate dallo
 * smartphone. Samsung (One UI) usa "<prefisso> <contatto o numero>_aaMMgg_hhmmss.m4a",
 * con un prefisso nella lingua del telefono; altri modelli "<numero>_aaaaMMgghhmmss"
 * oppure "<nome>@<numero>_aaaaMMgghhmmss". Si legge solo la parte finale con data e
 * ora (ora locale del telefono) e il contatto che la precede.
 */
import { isLocalDateTime } from "../domain/time.js";

export interface CallFileInfo {
  /** Nome del contatto in rubrica, se il telefono l'ha indicato. */
  contact: string | null;
  /** Numero dell'interlocutore, se il telefono l'ha indicato (solo cifre e "+"). */
  phoneNumber: string | null;
  /** Inizio della registrazione "YYYY-MM-DDTHH:mm", ora locale del telefono. */
  startedLocal: string | null;
}

/** Prefissi noti dei nomi dei file (Samsung in italiano e in inglese), dal più lungo. */
const PREFIXES = [
  "registrazione delle chiamate",
  "registrazione chiamata",
  "chiamata registrata",
  "call recording",
  "registrazione",
  "chiamata",
  "call",
];

const SHORT_STAMP = /^(.*?)[ _-](\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/;
const LONG_STAMP = /^(.*?)[ _-](\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})$/;
const PHONE = /^\+?[\d\s().-]{6,}$/;

export function parseCallFileName(fileName: string): CallFileInfo {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  const short = SHORT_STAMP.exec(base);
  const long = short === null ? LONG_STAMP.exec(base) : null;
  const match = short ?? long;
  if (match === null) return { ...counterpart(base), startedLocal: null };
  const [, rest = "", y, mo, d, h, mi] = match;
  const year = short !== null ? `20${y}` : (y ?? "");
  const local = `${year}-${mo}-${d}T${h}:${mi}`;
  return { ...counterpart(rest), startedLocal: isLocalDateTime(local) ? local : null };
}

/** Contatto e numero dalla parte del nome che precede data e ora. */
function counterpart(raw: string): Pick<CallFileInfo, "contact" | "phoneNumber"> {
  let text = raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const prefix = PREFIXES.find((p) => lower === p || lower.startsWith(`${p} `));
  if (prefix !== undefined) text = text.slice(prefix.length).trim();
  if (text === "") return { contact: null, phoneNumber: null };
  // "Nome@numero" (alcuni telefoni Huawei e Honor).
  const at = text.lastIndexOf("@");
  if (at > 0 && PHONE.test(text.slice(at + 1).trim())) {
    return { contact: text.slice(0, at).trim() || null, phoneNumber: normalizePhone(text.slice(at + 1)) };
  }
  if (PHONE.test(text)) return { contact: null, phoneNumber: normalizePhone(text) };
  return { contact: text, phoneNumber: null };
}

function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return `${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** Titolo leggibile della registrazione, es. "Telefonata con Mario Rossi (+393331234567)". */
export function callTitle(info: CallFileInfo): string {
  if (info.contact !== null && info.phoneNumber !== null) return `Telefonata con ${info.contact} (${info.phoneNumber})`;
  if (info.contact !== null) return `Telefonata con ${info.contact}`;
  if (info.phoneNumber !== null) return `Telefonata con ${info.phoneNumber}`;
  return "Telefonata registrata con il telefono";
}
