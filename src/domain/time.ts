/**
 * Date e fusi orari. Le date "locali" del dominio sono stringhe nel fuso dello
 * studio: "YYYY-MM-DD" (giorno) e "YYYY-MM-DDTHH:mm" (giorno e ora).
 */

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function validCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

export function isLocalDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const m = LOCAL_DATE.exec(value);
  return m !== null && validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isLocalDateTime(value: string | null | undefined): value is string {
  if (!value) return false;
  const m = LOCAL_DATE_TIME.exec(value);
  if (m === null) return false;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  return validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) && hour <= 23 && minute <= 59;
}

/** Componenti di data/ora di `date` nel fuso `timeZone`. */
export function toZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/**
 * Converte un'ora locale del fuso `timeZone` nell'istante UTC corrispondente.
 * Nelle ore che non esistono (passaggio all'ora legale) si sposta in avanti;
 * in quelle ripetute (ritorno all'ora solare) sceglie la prima occorrenza.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  let y: number, mo: number, d: number, h = 0, mi = 0;
  const dt = LOCAL_DATE_TIME.exec(local);
  const dOnly = LOCAL_DATE.exec(local);
  if (dt && isLocalDateTime(local)) {
    [y, mo, d, h, mi] = [Number(dt[1]), Number(dt[2]), Number(dt[3]), Number(dt[4]), Number(dt[5])];
  } else if (dOnly && isLocalDate(local)) {
    [y, mo, d] = [Number(dOnly[1]), Number(dOnly[2]), Number(dOnly[3])];
  } else {
    throw new Error(`Data locale non valida: "${local}"`);
  }
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  const localOf = (t: number): number => {
    const p = toZonedParts(new Date(t), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  // Offset (locale - UTC) poco prima e poco dopo: i cambi d'ora distano mesi, 6 ore bastano.
  const offsetBefore = localOf(wanted - 6 * 3_600_000) - (wanted - 6 * 3_600_000);
  const offsetAfter = localOf(wanted + 6 * 3_600_000) - (wanted + 6 * 3_600_000);
  const candidates = [wanted - offsetBefore, wanted - offsetAfter].filter((t) => localOf(t) === wanted);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // Ora inesistente: con l'offset precedente al cambio si cade dopo il salto.
  return new Date(wanted - offsetBefore);
}

/** "YYYY-MM-DD" del giorno di `date` nel fuso `timeZone`. */
export function localDateOf(date: Date, timeZone: string): string {
  const p = toZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "YYYY-MM-DDTHH:mm" di `date` nel fuso `timeZone`. */
export function localDateTimeOf(date: Date, timeZone: string): string {
  const p = toZonedParts(date, timeZone);
  return `${localDateOf(date, timeZone)}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Es. "mercoledì 7 ottobre 2026, 09:30". */
export function formatItalianDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Es. "giovedì 15 ottobre 2026" per una data locale "YYYY-MM-DD". */
export function formatItalianDate(localDate: string): string {
  if (!isLocalDate(localDate)) return localDate;
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Minutaggio dentro la registrazione: "mm:ss" oppure "h:mm:ss". */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Durata leggibile: "42 min", "1 h 05 min", "35 s". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const totalMin = Math.round(total / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}
