/**
 * Evento di calendario iCalendar (RFC 5545) importabile in Google Calendar,
 * Outlook e Apple Calendar. Gli eventi con orario sono espressi in UTC.
 */
import { isLocalDate, isLocalDateTime, zonedLocalToUtc } from "../domain/time.js";

export interface IcsEventInput {
  uid: string;
  title: string;
  description?: string;
  location?: string | null;
  /** Inizio locale "YYYY-MM-DDTHH:mm" nel fuso `timezone`; null per gli eventi di un giorno intero. */
  start: string | null;
  /** Giorno "YYYY-MM-DD" per gli eventi di un giorno intero (usato quando `start` è null). */
  allDayDate?: string;
  /** Durata degli eventi con orario (predefinita 60 minuti). */
  durationMinutes?: number;
  timezone: string;
  /** Promemoria, in minuti prima dell'inizio. */
  alarmsMinutesBefore?: number[];
  now: Date;
  url?: string;
}

const CRLF = "\r\n";
const MAX_LINE_OCTETS = 75;
const MINUTES_PER_DAY = 1440;

export function buildIcsEvent(ev: IcsEventInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Seguito//Studio Legale//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeText(ev.uid)}`,
    `DTSTAMP:${formatUtc(ev.now)}`,
    ...timeLines(ev),
    `SUMMARY:${escapeText(ev.title)}`,
  ];
  if (ev.description !== undefined && ev.description.trim() !== "") {
    lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  }
  if (ev.location != null && ev.location.trim() !== "") lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.url !== undefined) lines.push(`URL:${checkUri(ev.url)}`);
  for (const minutes of ev.alarmsMinutesBefore ?? []) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(ev.title)}`,
      `TRIGGER:${alarmTrigger(minutes)}`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

function timeLines(ev: IcsEventInput): string[] {
  if (ev.start !== null) {
    if (!isLocalDateTime(ev.start)) throw new Error(`Data e ora dell'evento non valide: «${ev.start}».`);
    const duration = ev.durationMinutes ?? 60;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`Durata dell'evento non valida: ${duration} minuti.`);
    }
    const start = zonedLocalToUtc(ev.start, ev.timezone);
    const end = new Date(start.getTime() + Math.round(duration) * 60_000);
    return [`DTSTART:${formatUtc(start)}`, `DTEND:${formatUtc(end)}`];
  }
  if (ev.allDayDate === undefined || !isLocalDate(ev.allDayDate)) {
    throw new Error("Evento senza una data valida: indicare la data o la data e l'ora.");
  }
  return [
    `DTSTART;VALUE=DATE:${ev.allDayDate.replaceAll("-", "")}`,
    `DTEND;VALUE=DATE:${nextDay(ev.allDayDate)}`,
    // Le scadenze di un giorno intero non occupano l'agenda.
    "TRANSP:TRANSPARENT",
  ];
}

/** "YYYYMMDD" del giorno successivo a una data locale valida. */
function nextDay(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replaceAll("-", "");
}

/** "YYYYMMDDTHHMMSSZ". */
function formatUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

function alarmTrigger(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0) throw new Error(`Promemoria non valido: ${minutes} minuti.`);
  return minutes > 0 && minutes % MINUTES_PER_DAY === 0 ? `-P${minutes / MINUTES_PER_DAY}D` : `-PT${minutes}M`;
}

/** Testo iCalendar: backslash, punto e virgola, virgola e a capo vanno protetti. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function checkUri(url: string): string {
  if (/[\u0000- \u007f]/.test(url)) throw new Error("Indirizzo web dell'evento non valido.");
  return url;
}

/** Piega le righe oltre 75 ottetti senza spezzare i caratteri UTF-8. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= MAX_LINE_OCTETS) return line;
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  // La prima riga ha 75 ottetti; le successive iniziano con uno spazio.
  let limit = MAX_LINE_OCTETS;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
      limit = MAX_LINE_OCTETS - 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}
