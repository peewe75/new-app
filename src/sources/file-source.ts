/**
 * Fonte su file locali: una cartella (o un singolo file) con trascrizioni.
 * Formati: dettaglio Plaud in JSON (con "source_list"), Recording in JSON
 * (con "segments"), testo .txt nel formato stampato dalla CLI Plaud.
 * Tutte le registrazioni restituite hanno source "file".
 */
import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isLocalDate, isLocalDateTime, zonedLocalToUtc } from "../domain/time.js";
import { type Recording, type RecordingRef, RecordingSchema, type Segment } from "../domain/types.js";
import {
  DEFAULT_SPEAKER,
  loadBlockContent,
  parsePlaudFile,
  PlaudFileSchema,
  plaudFileRef,
  PlaudNotReadyError,
  selectRecent,
} from "./plaud-parse.js";
import { recordingId, type RecordingSource } from "./source.js";

const SUPPORTED_EXTENSIONS = new Set([".json", ".txt"]);
const DEFAULT_TIMEZONE = "Europe/Rome";

export interface FileSourceOptions {
  /** Cartella con le trascrizioni oppure singolo file. */
  path: string;
  /** Fuso delle date senza offset nelle intestazioni dei .txt (predefinito Europe/Rome). */
  timezone?: string;
  now?: () => Date;
}

interface LocalEntry {
  ref: RecordingRef;
  load: () => Promise<Recording>;
}

export class FileSource implements RecordingSource {
  readonly name = "file" as const;
  private readonly path: string;
  private readonly timezone: string;
  private readonly now: () => Date;

  constructor(opts: FileSourceOptions) {
    this.path = opts.path;
    this.timezone = opts.timezone ?? DEFAULT_TIMEZONE;
    this.now = opts.now ?? (() => new Date());
  }

  async listRecent(opts: { since?: Date; limit?: number } = {}): Promise<RecordingRef[]> {
    const entries = await this.scan();
    return selectRecent(
      entries.map((e) => e.ref),
      opts,
    );
  }

  async fetchRecording(externalId: string): Promise<Recording> {
    const entry = (await this.scan()).find((e) => e.ref.externalId === externalId);
    if (!entry) {
      throw new Error(`Registrazione "${externalId}" non trovata in ${this.path}.`);
    }
    return entry.load();
  }

  /**
   * Voci dei file supportati, in ordine di nome (a parità di id vince il primo).
   * Un file illeggibile non blocca gli altri: il suo errore emerge al caricamento.
   */
  private async scan(): Promise<LocalEntry[]> {
    const entries = await Promise.all(
      (await this.listFiles()).map((file) => this.readEntry(file).catch((err: unknown) => this.brokenEntry(file, err))),
    );
    return entries.filter((entry) => entry !== null);
  }

  /** Voce di un file non interpretabile: compare nell'elenco, ma il caricamento restituisce l'errore. */
  private async brokenEntry(filePath: string, err: unknown): Promise<LocalEntry> {
    const startedAt = await stat(filePath).then(
      (info) => info.mtime.toISOString(),
      () => this.now().toISOString(),
    );
    const error = err instanceof Error ? err : new Error(`Il file "${basename(filePath)}" non è leggibile.`);
    return {
      ref: { externalId: basename(filePath, extname(filePath)), title: basename(filePath), startedAt, durationMs: null, ready: true },
      load: () => Promise.reject(error),
    };
  }

  private async listFiles(): Promise<string[]> {
    let info: Stats;
    try {
      info = await stat(this.path);
    } catch (cause) {
      throw new Error(`Percorso delle registrazioni non trovato: ${this.path}`, { cause });
    }
    if (info.isFile()) {
      if (!isSupported(this.path)) {
        throw new Error(
          `Formato non supportato per "${basename(this.path)}": sono ammessi file .json e .txt.`,
        );
      }
      return [this.path];
    }
    const dirents = await readdir(this.path, { withFileTypes: true });
    return dirents
      .filter((d) => d.isFile() && isSupported(d.name))
      .map((d) => d.name)
      .sort()
      .map((name) => join(this.path, name));
  }

  private async readEntry(filePath: string): Promise<LocalEntry | null> {
    const content = (await readFile(filePath, "utf8")).replace(/^﻿/, "");
    if (extname(filePath).toLowerCase() === ".txt") {
      return this.textEntry(filePath, content);
    }
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error(`Il file "${basename(filePath)}" non contiene un JSON valido.`);
    }
    if (!isRecord(json)) return null;
    if ("source_list" in json) return this.plaudEntry(filePath, json);
    if ("segments" in json) return this.recordingEntry(filePath, json);
    return null;
  }

  private async textEntry(filePath: string, content: string): Promise<LocalEntry> {
    const name = basename(filePath);
    const externalId = basename(filePath, extname(filePath));
    let parsed: ParsedTranscriptText;
    try {
      parsed = parseTranscriptText(content, this.timezone);
    } catch (err) {
      throw new Error(`File "${name}": ${errorMessage(err)}`);
    }
    if (parsed.segments.length === 0) {
      throw new Error(`Il file "${name}" non contiene interventi trascritti riconoscibili.`);
    }
    const startedAt = parsed.startedAt ?? (await stat(filePath)).mtime.toISOString();
    const ref: RecordingRef = {
      externalId,
      title: parsed.title ?? externalId,
      startedAt,
      durationMs: estimateDurationMs(parsed.segments),
      ready: true,
    };
    return {
      ref,
      load: async () => ({
        id: recordingId("file", externalId),
        source: "file",
        externalId,
        title: ref.title,
        startedAt,
        durationMs: ref.durationMs,
        segments: parsed.segments,
        plaudSummary: null,
        fetchedAt: this.now().toISOString(),
      }),
    };
  }

  private plaudEntry(filePath: string, json: Record<string, unknown>): LocalEntry {
    const name = basename(filePath);
    const parsed = PlaudFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Il file "${name}" non è un dettaglio di registrazione Plaud valido.`);
    }
    const file = parsed.data;
    const inlineOnly = (): Promise<string> =>
      Promise.reject(
        new Error(
          `Il file "${name}" rimanda a contenuti remoti (data_link): nei file locali il testo deve essere in data_content.`,
        ),
      );
    return {
      ref: { ...plaudFileRef(file), ready: true },
      load: async () => {
        try {
          const recording = await parsePlaudFile(
            file,
            (block) => loadBlockContent(block, inlineOnly),
            this.now(),
          );
          return { ...recording, source: "file", id: recordingId("file", recording.externalId) };
        } catch (err) {
          if (err instanceof PlaudNotReadyError) {
            throw new Error(`Il file "${name}" non contiene la trascrizione della registrazione.`);
          }
          throw err;
        }
      },
    };
  }

  private recordingEntry(filePath: string, json: Record<string, unknown>): LocalEntry {
    const name = basename(filePath);
    const parsed = RecordingSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Il file "${name}" non è una registrazione valida.`);
    }
    const recording = parsed.data;
    if (Number.isNaN(Date.parse(recording.startedAt))) {
      throw new Error(`Il file "${name}" ha una data di inizio non valida.`);
    }
    return {
      ref: {
        externalId: recording.externalId,
        title: recording.title,
        startedAt: recording.startedAt,
        durationMs: recording.durationMs,
        ready: true,
      },
      load: async () => ({
        ...recording,
        id: recordingId("file", recording.externalId),
        source: "file",
        fetchedAt: this.now().toISOString(),
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Trascrizioni in testo (formato della CLI Plaud)
// ---------------------------------------------------------------------------

export interface ParsedTranscriptText {
  /** Da "# title: ...", se presente. */
  title: string | null;
  /** Da "# startedAt: ...", normalizzato in ISO UTC, se presente. */
  startedAt: string | null;
  segments: Segment[];
}

const TIME = String.raw`\d+(?::\d{2}){1,2}`;
/** "[mm:ss] ...", "[h:mm:ss] ..." oppure "[mm:ss - mm:ss] ...". */
const SEGMENT_LINE = new RegExp(String.raw`^\[(${TIME})(?:\s*[-–]\s*(${TIME}))?\]\s*(.*)$`);
/** "Speaker 1: testo": i due punti devono essere seguiti da spazio (non "10:30"). */
const SPEAKER_PREFIX = /^([^:]{1,80}?):(?:\s+|$)(.*)$/;
const HEADER_LINE = /^#\s*([A-Za-z]+)\s*:\s*(.*)$/;

/**
 * Interpreta una trascrizione testuale. Le righe senza minutaggio continuano
 * l'intervento precedente; le intestazioni "# chiave: valore" sono ammesse
 * solo prima del primo intervento.
 */
export function parseTranscriptText(content: string, timeZone: string): ParsedTranscriptText {
  let title: string | null = null;
  let startedAt: string | null = null;
  const drafts: Array<Omit<Segment, "index" | "text"> & { lines: string[] }> = [];
  for (const [i, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "") continue;
    const segment = SEGMENT_LINE.exec(line);
    if (segment) {
      const rest = segment[3] ?? "";
      const speaker = SPEAKER_PREFIX.exec(rest);
      drafts.push({
        startMs: parseClock(segment[1] ?? "0:00"),
        endMs: segment[2] === undefined ? null : parseClock(segment[2]),
        speaker: speaker?.[1]?.trim() || DEFAULT_SPEAKER,
        lines: [speaker ? (speaker[2] ?? "") : rest],
      });
      continue;
    }
    const current = drafts.at(-1);
    if (current) {
      current.lines.push(line);
      continue;
    }
    const header = HEADER_LINE.exec(line);
    if (header) {
      const key = (header[1] ?? "").toLowerCase();
      const value = (header[2] ?? "").trim();
      if (key === "title" && value !== "") title = value;
      if (key === "startedat") startedAt = parseHeaderDate(value, timeZone);
      continue;
    }
    if (line.startsWith("#")) continue;
    throw new Error(`riga ${i + 1}: testo senza minutaggio prima del primo intervento.`);
  }
  const segments = drafts
    .map(({ lines: parts, ...rest }) => ({ ...rest, text: parts.join("\n").trim() }))
    .filter((s) => s.text !== "")
    .map((s, index) => ({ index, ...s }));
  return { title, startedAt, segments };
}

/** "mm:ss" oppure "h:mm:ss" in millisecondi. */
function parseClock(value: string): number {
  return value.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}

/**
 * Data di inizio dell'intestazione: con fuso esplicito (Z o offset) oppure
 * locale ("YYYY-MM-DD", "YYYY-MM-DDTHH:mm[:ss]") nel fuso dello studio.
 */
function parseHeaderDate(value: string, timeZone: string): string {
  const invalid = new Error(`data di inizio non valida nell'intestazione: "${value}".`);
  if (isLocalDate(value)) return zonedLocalToUtc(value, timeZone).toISOString();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const minute = `${local[1]}T${local[2]}`;
    if (!isLocalDateTime(minute)) throw invalid;
    const seconds = Number(local[3] ?? 0);
    return new Date(zonedLocalToUtc(minute, timeZone).getTime() + seconds * 1000).toISOString();
  }
  const ms = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw invalid;
  return new Date(ms).toISOString();
}

/** Durata stimata: fine (o inizio) dell'ultimo intervento; null se non deducibile. */
function estimateDurationMs(segments: readonly Segment[]): number | null {
  const last = segments.reduce((max, s) => Math.max(max, s.endMs ?? s.startMs), 0);
  return last > 0 ? last : null;
}

function isSupported(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
