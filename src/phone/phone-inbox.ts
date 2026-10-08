/**
 * Registrazioni delle chiamate inviate dallo smartphone: ricezione in streaming
 * (deduplicate per contenuto), trascrizione con il servizio configurato, poi la
 * stessa analisi e proposta delle registrazioni Plaud. L'audio si cancella non
 * appena la trascrizione è archiviata: sul server resta solo il testo.
 *
 * Una registrazione alla volta; gli errori transitori si ritentano con attese
 * crescenti, quelli definitivi restano in errore fino a «riprova».
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline as pipeStreams } from "node:stream/promises";
import { Transform } from "node:stream";
import { z } from "zod";
import { zonedLocalToUtc } from "../domain/time.js";
import { RecordingSchema, type Recording } from "../domain/types.js";
import { ExtractionError } from "../extract/claude-extractor.js";
import { processRecording, type PipelineDeps } from "../pipeline.js";
import { recordingId } from "../sources/source.js";
import { writeFileAtomic, writeFileIfAbsent } from "../store/json-store.js";
import { TranscriptionError, type Transcriber } from "../transcribe/transcriber.js";
import { callTitle, parseCallFileName, voiceTitle } from "./call-file-name.js";

export const PhoneUploadStatusSchema = z.enum([
  /** Ricevuta, in coda per la trascrizione. */
  "ricevuta",
  "in_trascrizione",
  "in_analisi",
  /** Proposta pronta da rivedere. */
  "pronta",
  /** Errore transitorio: nuovo tentativo programmato. */
  "in_attesa",
  /** Errore definitivo: serve «riprova» dopo averne rimosso la causa. */
  "errore",
]);
export type PhoneUploadStatus = z.infer<typeof PhoneUploadStatusSchema>;

/** chiamata: registrata dall'app Telefono; vocale: registratore vocale (riunioni, appunti). */
export const PhoneRecordingKindSchema = z.enum(["chiamata", "vocale"]);
export type PhoneRecordingKind = z.infer<typeof PhoneRecordingKindSchema>;

export const PhoneUploadSchema = z.object({
  id: z.string(),
  /** Assente nelle registrazioni ricevute prima delle registrazioni vocali: erano tutte chiamate. */
  kind: PhoneRecordingKindSchema.default("chiamata"),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  receivedAt: z.string(),
  contact: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  /** Inizio della chiamata (ISO 8601 UTC), dal nome del file o dalla data del file. */
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  title: z.string(),
  status: PhoneUploadStatusSchema,
  /** Messaggio in italiano per l'avvocato (errori, attese). */
  message: z.string().nullable(),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  recordingId: z.string().nullable(),
  proposalId: z.string().nullable(),
  updatedAt: z.string(),
});
export type PhoneUpload = z.infer<typeof PhoneUploadSchema>;

export interface ReceiveMeta {
  fileName: string;
  contentType: string;
  /** Predefinito: chiamata. */
  kind?: PhoneRecordingKind;
  /** Titolo indicato dall'avvocato sul telefono (registrazioni vocali), se presente. */
  title?: string | null;
  /** Data di ultima modifica del file sul telefono (ms), di solito la fine della chiamata. */
  lastModifiedMs: number | null;
  /** Durata indicata dal telefono, se nota. */
  durationMs: number | null;
}

export interface PhoneInboxOptions {
  dir: string;
  transcriber: Transcriber;
  deps: PipelineDeps;
  /** Dimensione massima di una registrazione, in byte. */
  maxBytes: number;
  language?: string;
  now?: () => Date;
  log?: (message: string) => void;
  /** Attese tra i tentativi dopo un errore transitorio. */
  retryDelaysMs?: readonly number[];
}

/** Richiesta di invio non valida: stato HTTP e messaggio in italiano. */
export class PhoneUploadError extends Error {
  override name = "PhoneUploadError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ID_LENGTH = 32;
const ID_PATTERN = /^[0-9a-f]{32}$/;
/** Tolleranza sull'orologio del telefono per le date nel futuro. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60_000;

const MESSAGES = {
  empty: "Il file ricevuto è vuoto.",
  tooLarge: (mb: number) => `La registrazione supera il limite di ${mb} MB (SEGUITO_TELEFONO_MAX_MB).`,
  emptyTranscript:
    "La trascrizione è vuota: la registrazione potrebbe non contenere voci (per esempio con gli auricolari collegati).",
  audioMissing: "Il file audio non è più disponibile sul server: inviare di nuovo la registrazione dal telefono.",
  unexpected: "Errore imprevisto durante l'elaborazione: riprovare. Se il problema persiste, consultare il registro del server.",
  notFound: "Registrazione non trovata.",
  notRetryable: "La registrazione è già stata elaborata.",
} as const;

export class PhoneInbox {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly retryDelays: readonly number[];
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly queued = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly opts: PhoneInboxOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => undefined);
    this.retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** Dimensione massima di una registrazione, in byte. */
  get maxBytes(): number {
    return this.opts.maxBytes;
  }

  /** Riceve una registrazione; se lo stesso audio è già arrivato restituisce quella esistente. */
  async receive(body: Readable, meta: ReceiveMeta): Promise<{ upload: PhoneUpload; created: boolean }> {
    await mkdir(this.opts.dir, { recursive: true, mode: DIR_MODE });
    const tmp = join(this.opts.dir, `.in-${randomBytes(8).toString("hex")}`);
    let size = 0;
    const hash = createHash("sha256");
    const limit = this.opts.maxBytes;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > limit) {
          callback(new PhoneUploadError(413, MESSAGES.tooLarge(Math.floor(limit / (1024 * 1024)))));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeStreams(body, counter, createWriteStream(tmp, { mode: FILE_MODE, flags: "wx" }));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    if (size === 0) {
      await rm(tmp, { force: true });
      throw new PhoneUploadError(400, MESSAGES.empty);
    }
    const id = hash.digest("hex").slice(0, ID_LENGTH);
    try {
      const existing = await this.get(id);
      if (existing !== null) {
        if (await this.needsAudioAgain(existing)) return { upload: await this.restart(existing, tmp), created: true };
        await rm(tmp, { force: true });
        return { upload: existing, created: false };
      }
      const upload = this.newUpload(id, meta, size);
      await rename(tmp, this.audioPath(id));
      if (!(await writeFileIfAbsent(this.metaPath(id), serialize(upload)))) {
        // Stesso audio arrivato in contemporanea: vale la prima registrazione.
        return { upload: (await this.get(id)) ?? upload, created: false };
      }
      this.log(`Registrazione dal telefono ricevuta: «${upload.title}».`);
      this.enqueue(id);
      return { upload, created: true };
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(id: string): Promise<PhoneUpload | null> {
    if (!ID_PATTERN.test(id)) return null;
    const loaded = await this.load(id);
    return typeof loaded === "string" ? null : loaded;
  }

  /** Le registrazioni più recenti per prime. */
  async list(limit = 50): Promise<PhoneUpload[]> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return [];
    }
    const uploads = await Promise.all(
      names.filter((n) => /^[0-9a-f]{32}\.json$/.test(n)).map((n) => this.get(n.slice(0, ID_LENGTH))),
    );
    return uploads
      .filter((u): u is PhoneUpload => u !== null)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  /** Ripete subito l'elaborazione di una registrazione in errore o in attesa. */
  async retry(id: string): Promise<PhoneUpload> {
    const upload = await this.get(id);
    if (upload === null) throw new PhoneUploadError(404, MESSAGES.notFound);
    if (upload.status !== "errore" && upload.status !== "in_attesa") throw new PhoneUploadError(409, MESSAGES.notRetryable);
    const reset = await this.save({ ...upload, status: "ricevuta", message: null, attempts: 0, nextAttemptAt: null });
    this.enqueue(id);
    return reset;
  }

  /** All'avvio: elimina i resti di invii interrotti, riprende le registrazioni a metà e riprogramma i tentativi. */
  async resume(): Promise<void> {
    await this.sweep();
    for (const upload of await this.list(Number.MAX_SAFE_INTEGER)) {
      if (upload.status === "ricevuta" || upload.status === "in_trascrizione" || upload.status === "in_analisi") {
        this.enqueue(upload.id);
      } else if (upload.status === "in_attesa") {
        const wait = upload.nextAttemptAt === null ? 0 : Date.parse(upload.nextAttemptAt) - this.now().getTime();
        this.schedule(upload.id, Math.max(0, wait));
      }
    }
  }

  /** Attende che la coda sia vuota (prove). */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  /**
   * Arresto del server: annulla i tentativi programmati e interrompe la
   * trascrizione in corso (il lavoro presso il servizio viene cancellato). Le
   * registrazioni interrotte restano nel loro stato e riprendono al riavvio.
   */
  stop(): void {
    this.stopped = true;
    this.abort.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private enqueue(id: string): void {
    if (this.stopped || this.queued.has(id)) return;
    this.queued.add(id);
    this.chain = this.chain.then(async () => {
      this.queued.delete(id);
      try {
        await this.process(id);
      } catch (err) {
        console.error("[seguito] Errore nell'elaborazione di una registrazione dal telefono:", err);
      }
    });
  }

  private schedule(id: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.enqueue(id);
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private async process(id: string): Promise<void> {
    if (this.stopped) return;
    let upload = await this.get(id);
    if (upload === null || upload.status === "pronta" || upload.status === "errore") return;
    try {
      let recording: Recording | null = null;
      if (upload.recordingId === null) {
        upload = await this.save({ ...upload, status: "in_trascrizione", message: null });
        recording = await this.transcribe(upload);
        await this.opts.deps.store.saveRecording(recording);
        upload = await this.save({ ...upload, recordingId: recording.id, durationMs: recording.durationMs });
        // Trascrizione archiviata: l'audio non serve più.
        await rm(this.audioPath(id), { force: true });
      } else {
        recording = await this.opts.deps.store.getRecording(upload.recordingId);
        if (recording === null) throw new PhoneUploadError(410, MESSAGES.audioMissing);
      }
      upload = await this.save({ ...upload, status: "in_analisi", message: null });
      const { proposal } = await processRecording(recording, this.opts.deps, { now: this.now() });
      await this.save({ ...upload, status: "pronta", message: null, nextAttemptAt: null, proposalId: proposal.id });
      this.log(`Proposta pronta per «${upload.title}».`);
    } catch (err) {
      // Interrotta dall'arresto: lo stato resta «in corso» e resume() la riprende.
      if (this.stopped) return;
      await this.fail(upload, err);
    }
  }

  private async transcribe(upload: PhoneUpload): Promise<Recording> {
    const audioPath = this.audioPath(upload.id);
    const transcript = await this.opts.transcriber.transcribe({
      audioPath,
      contentType: upload.contentType,
      language: this.opts.language ?? "it",
      signal: this.abort.signal,
    });
    const segments = transcript.segments
      .map((s) => ({ ...s, text: s.text.trim() }))
      .filter((s) => s.text !== "")
      .map((s, index) => ({ index, ...s }));
    if (segments.length === 0) throw new TranscriptionError(MESSAGES.emptyTranscript, false);
    const lastEnd = segments.at(-1)?.endMs ?? null;
    return RecordingSchema.parse({
      id: recordingId("telefono", upload.id),
      source: "telefono",
      externalId: upload.id,
      title: upload.title,
      startedAt: upload.startedAt,
      durationMs: transcript.durationMs ?? upload.durationMs ?? lastEnd,
      segments,
      plaudSummary: null,
      fetchedAt: this.now().toISOString(),
    });
  }

  private async fail(upload: PhoneUpload, err: unknown): Promise<void> {
    const message = userMessage(err);
    const retryable =
      (err instanceof TranscriptionError && err.retryable) || (err instanceof ExtractionError && err.retryable);
    const delay = retryable ? this.retryDelays[upload.attempts] : undefined;
    if (delay === undefined) {
      await this.save({ ...upload, status: "errore", message, nextAttemptAt: null });
      this.log(`Registrazione «${upload.title}» non elaborata: ${message}`);
      return;
    }
    const nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    await this.save({ ...upload, status: "in_attesa", message, attempts: upload.attempts + 1, nextAttemptAt });
    this.log(`Registrazione «${upload.title}»: nuovo tentativo alle ${nextAttemptAt}. ${message}`);
    this.schedule(upload.id, delay);
  }

  private newUpload(id: string, meta: ReceiveMeta, sizeBytes: number): PhoneUpload {
    const fileName = safeFileName(meta.fileName);
    const kind = meta.kind ?? "chiamata";
    const info = parseCallFileName(fileName);
    const now = this.now();
    return {
      id,
      kind,
      fileName,
      contentType: meta.contentType,
      sizeBytes,
      receivedAt: now.toISOString(),
      // Nelle registrazioni vocali il nome del file non indica un interlocutore.
      contact: kind === "chiamata" ? info.contact : null,
      phoneNumber: kind === "chiamata" ? info.phoneNumber : null,
      startedAt: this.startedAt(info.startedLocal, meta, now),
      durationMs: meta.durationMs,
      title: kind === "chiamata" ? callTitle(info) : voiceTitle(fileName, meta.title ?? null),
      status: "ricevuta",
      message: null,
      attempts: 0,
      nextAttemptAt: null,
      recordingId: null,
      proposalId: null,
      updatedAt: now.toISOString(),
    };
  }

  /**
   * Inizio della chiamata: dal nome del file, altrimenti fine del file meno la
   * durata, altrimenti ora. Una data assurda indicata dal telefono vale «ora».
   */
  private startedAt(startedLocal: string | null, meta: ReceiveMeta, now: Date): string {
    if (startedLocal !== null) return zonedLocalToUtc(startedLocal, this.opts.deps.studio.timezone).toISOString();
    if (meta.lastModifiedMs !== null) {
      const started = new Date(meta.lastModifiedMs - (meta.durationMs ?? 0));
      const time = started.getTime();
      if (Number.isFinite(time) && time <= now.getTime() + MAX_CLOCK_SKEW_MS) return started.toISOString();
    }
    return now.toISOString();
  }

  /** Stato della registrazione: assente, oppure illeggibile (file danneggiato, per esempio dopo un blackout). */
  private async load(id: string): Promise<PhoneUpload | "assente" | "illeggibile"> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(id), "utf8");
    } catch {
      return "assente";
    }
    try {
      const parsed = PhoneUploadSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // JSON non valido
    }
    console.error(`[seguito] Stato illeggibile per la registrazione dal telefono ${id}.`);
    return "illeggibile";
  }

  /**
   * Il telefono ha inviato di nuovo un audio già ricevuto: serve davvero solo se
   * la registrazione è in errore e non ci sono più né l'audio né la trascrizione.
   */
  private async needsAudioAgain(upload: PhoneUpload): Promise<boolean> {
    if (upload.status !== "errore" || (await exists(this.audioPath(upload.id)))) return false;
    return upload.recordingId === null || (await this.opts.deps.store.getRecording(upload.recordingId)) === null;
  }

  /** Riparte da capo con l'audio appena ricevuto. */
  private async restart(upload: PhoneUpload, tmp: string): Promise<PhoneUpload> {
    await rename(tmp, this.audioPath(upload.id));
    const reset = await this.save({
      ...upload,
      status: "ricevuta",
      message: null,
      attempts: 0,
      nextAttemptAt: null,
      recordingId: null,
      proposalId: null,
    });
    this.log(`Registrazione dal telefono ricevuta di nuovo: «${upload.title}».`);
    this.enqueue(upload.id);
    return reset;
  }

  /**
   * Pulizia all'avvio, prima di accettare invii: file parziali di invii
   * interrotti, audio senza registrazione o già trascritto, stati illeggibili
   * (il telefono conserva l'originale e può inviarlo di nuovo).
   */
  private async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return;
    }
    const ids = new Set<string>();
    for (const name of names) {
      if (name.startsWith(".in-")) {
        await rm(join(this.opts.dir, name), { force: true });
        continue;
      }
      const match = /^([0-9a-f]{32})\.(json|audio)$/.exec(name);
      if (match?.[1] !== undefined) ids.add(match[1]);
    }
    for (const id of ids) {
      const loaded = await this.load(id);
      if (loaded === "illeggibile") {
        await rm(this.metaPath(id), { force: true });
        await rm(this.audioPath(id), { force: true });
        this.log(`Stato di una registrazione dal telefono danneggiato (${id}): eliminata; se serve, inviarla di nuovo dal telefono.`);
      } else if (loaded === "assente" || loaded.recordingId !== null) {
        await rm(this.audioPath(id), { force: true });
      }
    }
  }

  private async save(upload: PhoneUpload): Promise<PhoneUpload> {
    const updated = { ...upload, updatedAt: this.now().toISOString() };
    await writeFileAtomic(this.metaPath(upload.id), serialize(updated));
    return updated;
  }

  private metaPath(id: string): string {
    return join(this.opts.dir, `${id}.json`);
  }

  private audioPath(id: string): string {
    return join(this.opts.dir, `${id}.audio`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function serialize(upload: PhoneUpload): string {
  return `${JSON.stringify(upload, null, 2)}\n`;
}

/** Solo il nome del file, senza percorsi né caratteri di controllo. */
function safeFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "registrazione").slice(0, 200);
}

/** Messaggio per l'avvocato: quelli dei moduli del progetto sono già in italiano. */
function userMessage(err: unknown): string {
  if (err instanceof TranscriptionError || err instanceof ExtractionError || err instanceof PhoneUploadError) {
    return err.message;
  }
  if (err instanceof Error && err.constructor === Error && err.message.trim() !== "") return err.message;
  console.error("[seguito] Errore imprevisto su una registrazione dal telefono:", err);
  return MESSAGES.unexpected;
}
