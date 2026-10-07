/**
 * Formato dei file Plaud (API sviluppatori) e conversione in Recording.
 * Usato sia dalla fonte API sia dalla fonte su file locali.
 */
import { isIP } from "node:net";
import { z } from "zod";
import type { Recording, RecordingRef, Segment } from "../domain/types.js";
import { recordingId } from "./source.js";

/** Etichetta usata quando Plaud non indica il parlante. */
export const DEFAULT_SPEAKER = "Parlante";
/** Numero massimo di registrazioni restituite da `listRecent` se non indicato. */
export const DEFAULT_LIST_LIMIT = 50;

const UNTITLED = "Registrazione senza titolo";
const TRANSCRIPT_TYPES = ["transaction", "transaction_polish"] as const;
const SUMMARY_TYPE = "auto_sum_note";
/** Il template personalizzato dello studio contiene "Seguito" nel titolo. */
const STUDIO_TEMPLATE_MARK = "seguito";
const LINK_TIMEOUT_MS = 30_000;
const LINK_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Errori
// ---------------------------------------------------------------------------

/** La registrazione esiste ma Plaud non ha ancora prodotto la trascrizione. */
export class PlaudNotReadyError extends Error {
  override name = "PlaudNotReadyError";
  constructor(message = "La trascrizione non è ancora disponibile in Plaud: riprovare più tardi.") {
    super(message);
  }
}

/** Credenziali Plaud mancanti, scadute o rifiutate. */
export class PlaudAuthError extends Error {
  override name = "PlaudAuthError";
  constructor(
    message = 'Accesso a Plaud non autorizzato o scaduto. Eseguire "npx @plaud-ai/cli login" e riprovare.',
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Risposta HTTP non riuscita. Il corpo non è mai riportato: può contenere dati personali. */
export class PlaudApiError extends Error {
  override name = "PlaudApiError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Schemi delle risposte Plaud
// ---------------------------------------------------------------------------

const PlaudBlockSchema = z.object({
  data_type: z.string(),
  data_content: z.string().nullish(),
  data_link: z.string().nullish(),
});
export type PlaudBlock = z.infer<typeof PlaudBlockSchema>;

const PlaudNoteSchema = PlaudBlockSchema.extend({
  data_title: z.string().nullish(),
  data_tab_name: z.string().nullish(),
});
export type PlaudNote = z.infer<typeof PlaudNoteSchema>;

export const PlaudFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  created_at: z.string().nullish(),
  start_at: z.string().nullish(),
  /** Durata in millisecondi. */
  duration: z.number().nullish(),
  source_list: z.array(PlaudBlockSchema).nullish(),
  note_list: z.array(PlaudNoteSchema).nullish(),
});
export type PlaudFile = z.infer<typeof PlaudFileSchema>;

/** Segmento della trascrizione Plaud ("transaction"): tempi in millisecondi. */
const PlaudTranscriptSchema = z.array(
  z.object({
    start_time: z.number(),
    end_time: z.number().nullish(),
    speaker: z.string().nullish(),
    content: z.string().nullish(),
  }),
);

/** Restituisce il contenuto testuale di un blocco. */
export type BlockLoader = (block: PlaudBlock) => Promise<string>;

// ---------------------------------------------------------------------------
// Conversione
// ---------------------------------------------------------------------------

const HAS_TIME = /\d{1,2}:\d{2}/;
const HAS_ZONE = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * Normalizza un orario Plaud in ISO 8601 UTC. Gli orari senza fuso sono UTC.
 * Restituisce null se il valore manca o non è interpretabile.
 */
export function parsePlaudTimestamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let normalized = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) +(?=\d)/, "$1T");
  if (HAS_TIME.test(normalized) && !HAS_ZONE.test(normalized)) normalized += "Z";
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Riferimento sintetico; pronta = durata positiva (l'elenco non dice se c'è la trascrizione). */
export function plaudFileRef(file: PlaudFile): RecordingRef {
  const startedAt = parsePlaudTimestamp(file.start_at) ?? parsePlaudTimestamp(file.created_at);
  if (startedAt === null) {
    throw new Error(`La registrazione Plaud "${file.id}" non ha una data di inizio valida.`);
  }
  const durationMs =
    typeof file.duration === "number" && Number.isFinite(file.duration) && file.duration >= 0
      ? file.duration
      : null;
  return {
    externalId: file.id,
    title: file.name?.trim() || UNTITLED,
    startedAt,
    durationMs,
    ready: (durationMs ?? 0) > 0,
  };
}

/** Converte il dettaglio di un file Plaud in Recording (trascrizione e riassunto). */
export async function parsePlaudFile(
  file: PlaudFile,
  loadBlock: BlockLoader,
  fetchedAt: Date,
): Promise<Recording> {
  const ref = plaudFileRef(file);
  const segments = await loadTranscript(file, loadBlock);
  const plaudSummary = await loadSummary(file, loadBlock);
  return {
    id: recordingId("plaud", file.id),
    source: "plaud",
    externalId: file.id,
    title: ref.title,
    startedAt: ref.startedAt,
    durationMs: ref.durationMs,
    segments,
    plaudSummary,
    fetchedAt: fetchedAt.toISOString(),
  };
}

/** Testo inline del blocco se presente, altrimenti scaricato da `data_link`. */
export async function loadBlockContent(
  block: PlaudBlock,
  fetchLink: (url: string) => Promise<string>,
): Promise<string> {
  if (typeof block.data_content === "string" && block.data_content.trim() !== "") {
    return block.data_content;
  }
  if (block.data_link) return fetchLink(block.data_link);
  return "";
}

async function loadTranscript(file: PlaudFile, loadBlock: BlockLoader): Promise<Segment[]> {
  for (const type of TRANSCRIPT_TYPES) {
    const block = file.source_list?.find((b) => b.data_type === type);
    if (!block) continue;
    const content = (await loadBlock(block)).trim();
    if (content === "") continue;
    const segments = parseTranscriptJson(content);
    if (segments.length > 0) return segments;
  }
  throw new PlaudNotReadyError();
}

function parseTranscriptJson(content: string): Segment[] {
  const invalid = "La trascrizione ricevuta da Plaud non è in un formato riconosciuto.";
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    // Niente `cause`: il messaggio di JSON.parse riporta parti del testo.
    throw new Error(invalid);
  }
  const parsed = PlaudTranscriptSchema.safeParse(json);
  if (!parsed.success) throw new Error(invalid);
  return parsed.data
    .map((s) => ({
      startMs: s.start_time,
      endMs: s.end_time ?? null,
      speaker: s.speaker?.trim() || DEFAULT_SPEAKER,
      text: (s.content ?? "").trim(),
    }))
    .filter((s) => s.text !== "")
    .map((s, index) => ({ index, ...s }));
}

async function loadSummary(file: PlaudFile, loadBlock: BlockLoader): Promise<string | null> {
  const notes = (file.note_list ?? []).filter((n) => n.data_type === SUMMARY_TYPE);
  const note = notes.find(isStudioTemplate) ?? notes[0];
  if (!note) return null;
  const content = (await loadBlock(note)).trim();
  return content === "" ? null : content;
}

function isStudioTemplate(note: PlaudNote): boolean {
  return [note.data_title, note.data_tab_name].some(
    (label) => label?.toLowerCase().includes(STUDIO_TEMPLATE_MARK) ?? false,
  );
}

/** Deduplica (vince il primo), filtra per `since`, ordina dalla più recente e limita. */
export function selectRecent(
  refs: readonly RecordingRef[],
  opts: { since?: Date; limit?: number } = {},
): RecordingRef[] {
  const sinceMs = opts.since?.getTime() ?? Number.NEGATIVE_INFINITY;
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIST_LIMIT));
  const seen = new Set<string>();
  const firstOccurrence = (ref: RecordingRef): boolean => {
    if (seen.has(ref.externalId)) return false;
    seen.add(ref.externalId);
    return true;
  };
  return refs
    .filter(firstOccurrence)
    .filter((ref) => Date.parse(ref.startedAt) >= sinceMs)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function networkError(cause: unknown): Error {
  const timedOut =
    typeof cause === "object" && cause !== null && "name" in cause && cause.name === "TimeoutError";
  return new Error(
    timedOut
      ? "Plaud non ha risposto entro il tempo massimo: riprovare più tardi."
      : "Impossibile contattare Plaud: verificare la connessione e riprovare.",
    { cause },
  );
}

/** `fetch` che trasforma gli errori di rete in messaggi comprensibili. */
export async function plaudFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (cause) {
    throw networkError(cause);
  }
}

/** Legge il corpo come testo; gli errori di rete (anche timeout) diventano messaggi chiari. */
export async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (cause) {
    throw networkError(cause);
  }
}

/** Scarta il corpo di una risposta non usata, liberando la connessione. */
export function discardBody(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Collegamento al contenuto Plaud non valido.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Collegamento al contenuto Plaud non consentito: è richiesto HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Collegamento al contenuto Plaud non consentito: contiene credenziali.");
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    throw new Error("Collegamento al contenuto Plaud non consentito: indirizzo IP diretto.");
  }
  return url;
}

function tooLarge(maxBytes: number): Error {
  const mb = Math.round(maxBytes / (1024 * 1024));
  return new Error(`Il contenuto scaricato da Plaud supera il limite di ${mb} MB.`);
}

async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    discardBody(res);
    throw tooLarge(maxBytes);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const read = async () => {
    try {
      return await reader.read();
    } catch (cause) {
      throw networkError(cause);
    }
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let chunk = await read(); !chunk.done; chunk = await read()) {
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(chunk.value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/**
 * Scarica un contenuto Plaud (`data_link`, URL prefirmato) come testo.
 * Solo HTTPS, niente credenziali nell'URL né IP diretti (anche dopo i
 * reindirizzamenti), timeout e dimensione massima. Nessun token inviato.
 */
export async function safeFetchText(url: string, opts: SafeFetchOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? LINK_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? LINK_TIMEOUT_MS);
  let current = assertSafeUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await plaudFetch(fetchImpl, current.href, { redirect: "manual", signal });
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      discardBody(res);
      if (!location) throw new Error("Reindirizzamento di Plaud senza destinazione.");
      current = assertSafeUrl(new URL(location, current).href);
      continue;
    }
    if (!res.ok) {
      discardBody(res);
      throw new PlaudApiError(res.status, `Impossibile scaricare il contenuto da Plaud (HTTP ${res.status}).`);
    }
    return readTextLimited(res, maxBytes);
  }
  throw new Error("Troppi reindirizzamenti durante il download del contenuto Plaud.");
}
