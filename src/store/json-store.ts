/**
 * Archivio locale su file JSON: registrazioni, proposte e checkpoint.
 * Contiene dati riservati dei clienti: cartelle 0700 e file 0600.
 *
 * Struttura: <dataDir>/recordings/<id codificato>.json,
 * <dataDir>/proposals/<id codificato>.json, <dataDir>/checkpoints.json.
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ProposalSchema, RecordingSchema, type Proposal, type Recording } from "../domain/types.js";
import type { Store } from "./store.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Margine sotto il limite di 255 byte dei nomi di file. */
const MAX_ENCODED_ID = 200;
const ENCODED_NAME = /^(?:[a-z0-9-]|_[0-9A-F]{2})+$/;

const CheckpointsSchema = z.record(z.string(), z.string());

export function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Scrittura atomica (file temporaneo nella stessa cartella + rename) con permessi riservati. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
  const tmp = `${filePath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, { mode: FILE_MODE, flag: "wx" });
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Id -> nome di file, in modo invertibile e sicuro anche su file system che
 * non distinguono maiuscole: restano solo [a-z0-9-], ogni altro byte UTF-8
 * diventa "_" + due cifre esadecimali maiuscole (es. ":" -> "_3A").
 */
export function encodeIdForFileName(id: string): string {
  if (id === "") throw new Error("Identificativo vuoto: impossibile archiviarlo.");
  let out = "";
  for (const byte of Buffer.from(id, "utf8")) {
    const char = String.fromCharCode(byte);
    out += /[a-z0-9-]/.test(char) ? char : `_${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (out.length > MAX_ENCODED_ID) throw new Error("Identificativo troppo lungo per l'archivio.");
  return out;
}

/** Inverso di `encodeIdForFileName`; null per nomi che non sono codifiche canoniche. */
export function decodeFileNameToId(name: string): string | null {
  if (name.length > MAX_ENCODED_ID || !ENCODED_NAME.test(name)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === "_") {
      bytes.push(Number.parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  const id = Buffer.from(bytes).toString("utf8");
  return encodeIdForFileName(id) === name ? id : null;
}

export class JsonFileStore implements Store {
  private readonly recordingsDir: string;
  private readonly proposalsDir: string;
  private readonly checkpointsFile: string;
  /** Serializza gli aggiornamenti dei checkpoint (lettura-modifica-scrittura). */
  private checkpointQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    const root = resolve(dataDir);
    this.recordingsDir = join(root, "recordings");
    this.proposalsDir = join(root, "proposals");
    this.checkpointsFile = join(root, "checkpoints.json");
  }

  async saveRecording(recording: Recording): Promise<void> {
    const valid = RecordingSchema.parse(recording);
    await writeJson(this.recordingPath(valid.id), valid);
  }

  async getRecording(id: string): Promise<Recording | null> {
    return readEntity(this.recordingPath(id), RecordingSchema, id, "registrazione");
  }

  async hasRecording(id: string): Promise<boolean> {
    return exists(this.recordingPath(id));
  }

  async saveProposal(proposal: Proposal): Promise<void> {
    const valid = ProposalSchema.parse(proposal);
    await writeJson(this.proposalPath(valid.id), valid);
  }

  async getProposal(id: string): Promise<Proposal | null> {
    return readEntity(this.proposalPath(id), ProposalSchema, id, "proposta");
  }

  async listProposals(): Promise<Proposal[]> {
    let names: string[];
    try {
      names = await readdir(this.proposalsDir);
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
    const proposals: Proposal[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? decodeFileNameToId(name.slice(0, -".json".length)) : null;
      if (id === null) continue;
      const proposal = await this.getProposal(id);
      if (proposal !== null) proposals.push(proposal);
    }
    return proposals.sort(
      (a, b) => timeOf(b.recording.startedAt) - timeOf(a.recording.startedAt) || a.id.localeCompare(b.id),
    );
  }

  async getCheckpoint(key: string): Promise<string | null> {
    return (await this.readCheckpoints()).get(key) ?? null;
  }

  setCheckpoint(key: string, value: string): Promise<void> {
    const run = this.checkpointQueue.then(async () => {
      const checkpoints = await this.readCheckpoints();
      checkpoints.set(key, value);
      await writeJson(this.checkpointsFile, Object.fromEntries(checkpoints));
    });
    this.checkpointQueue = run.catch(() => undefined);
    return run;
  }

  private recordingPath(id: string): string {
    return join(this.recordingsDir, `${encodeIdForFileName(id)}.json`);
  }

  private proposalPath(id: string): string {
    return join(this.proposalsDir, `${encodeIdForFileName(id)}.json`);
  }

  private async readCheckpoints(): Promise<Map<string, string>> {
    const raw = await readJsonFile(this.checkpointsFile);
    if (raw === null) return new Map();
    const parsed = CheckpointsSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Archivio: il file dei checkpoint non è valido.");
    return new Map(Object.entries(parsed.data));
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Contenuto JSON del file, null se il file non esiste. */
async function readJsonFile(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Archivio: il file ${basename(filePath)} non contiene JSON valido.`);
  }
}

async function readEntity<S extends z.ZodType<{ id: string }>>(
  filePath: string,
  schema: S,
  id: string,
  what: string,
): Promise<z.output<S> | null> {
  const raw = await readJsonFile(filePath);
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Archivio: ${what} non valida nel file ${basename(filePath)}.`);
  if (parsed.data.id !== id) throw new Error(`Archivio: il file ${basename(filePath)} non corrisponde a «${id}».`);
  return parsed.data;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
