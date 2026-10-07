/**
 * Gestionale di riferimento su file JSON (anagrafiche, pratiche, note).
 * Il file è letto al primo uso e riletto a ogni operazione, così più istanze
 * sullo stesso file restano coerenti; le operazioni sullo stesso file sono
 * messe in coda e ogni scrittura è atomica.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { toZonedParts } from "../domain/time.js";
import {
  CaseManagementDataSchema,
  ClientSchema,
  type CaseManagementData,
  type Client,
  type ClientMatch,
  type Matter,
  type MatterNote,
} from "../domain/types.js";
import { isNotFoundError, writeFileAtomic } from "../store/json-store.js";
import type { CaseManagement, ClientQuery } from "./case-management.js";

export interface JsonCaseManagementOptions {
  /** Orologio per date di apertura e note (sostituibile nei test). */
  now?: () => Date;
  /** Fuso orario per l'anno del numero di pratica. */
  timeZone?: string;
}

const MIN_SCORE = 0.5;
const SCORE = {
  email: 1,
  phone: 0.95,
  fullName: 0.9,
  organization: 0.85,
  surname: 0.6,
  /** Stesso cognome ma nome diverso: candidato debole, sotto la soglia di collegamento automatico (0,6). */
  surnameOtherFirstName: 0.5,
} as const;
/** Cifre finali confrontate per i numeri di telefono (prefissi esclusi). */
const PHONE_DIGITS = 9;
const MIN_PHONE_DIGITS = 6;

/** Titoli e forme societarie ignorati nel confronto dei nomi (già privi di punti). */
const IGNORED_TOKENS: ReadonlySet<string> = new Set(
  "sig sigra signor signora dott dottssa dottor dottoressa avv avvocato ing geom rag prof srl srls spa snc sas".split(
    " ",
  ),
);

/** Code delle operazioni per file, condivise da tutte le istanze del processo. */
const queues = new Map<string, Promise<unknown>>();

export class JsonCaseManagement implements CaseManagement {
  readonly name = "gestionale-json";
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly timeZone: string;

  constructor(filePath: string, options: JsonCaseManagementOptions = {}) {
    this.filePath = resolve(filePath);
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "Europe/Rome";
  }

  async findClients(query: ClientQuery): Promise<ClientMatch[]> {
    const data = await this.read();
    const matches: ClientMatch[] = [];
    for (const client of data.clients) {
      const best = scoreClient(client, query);
      if (best === null || best.score < MIN_SCORE) continue;
      matches.push({
        clientId: client.id,
        displayName: client.displayName,
        email: client.email,
        phone: client.phone,
        matterIds: data.matters.filter((m) => m.clientId === client.id).map((m) => m.id),
        score: best.score,
        matchedOn: best.matchedOn,
      });
    }
    return matches.sort((a, b) => b.score - a.score);
  }

  async getClient(id: string): Promise<Client | null> {
    const data = await this.read();
    return data.clients.find((c) => c.id === id) ?? null;
  }

  createClient(input: Omit<Client, "id">): Promise<Client> {
    return this.mutate((data) => {
      const client = ClientSchema.parse({ ...input, id: nextId("C", data.clients) });
      data.clients.push(client);
      return client;
    });
  }

  async listMatters(clientId: string): Promise<Matter[]> {
    const data = await this.read();
    return data.matters.filter((m) => m.clientId === clientId);
  }

  createMatter(input: { clientId: string; title: string; status: Matter["status"] }): Promise<Matter> {
    return this.mutate((data) => {
      if (!data.clients.some((c) => c.id === input.clientId)) {
        throw new Error(`Cliente ${input.clientId} non presente nel gestionale.`);
      }
      const now = this.now();
      const matter: Matter = {
        id: nextId("M", data.matters),
        clientId: input.clientId,
        number: nextMatterNumber(data.matters, toZonedParts(now, this.timeZone).year),
        title: input.title.trim(),
        status: input.status,
        openedAt: now.toISOString(),
        notes: [],
      };
      data.matters.push(matter);
      return matter;
    });
  }

  addMatterNote(matterId: string, note: Omit<MatterNote, "id" | "at">): Promise<MatterNote> {
    return this.mutate((data) => {
      const matter = data.matters.find((m) => m.id === matterId);
      if (matter === undefined) throw new Error(`Pratica ${matterId} non presente nel gestionale.`);
      const allNotes = data.matters.flatMap((m) => m.notes);
      const saved: MatterNote = {
        id: nextId("N", allNotes),
        at: this.now().toISOString(),
        author: note.author,
        kind: note.kind,
        text: note.text,
        sourceRecordingId: note.sourceRecordingId,
      };
      matter.notes.push(saved);
      return saved;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = (queues.get(this.filePath) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => undefined);
    queues.set(this.filePath, settled);
    return run;
  }

  private read(): Promise<CaseManagementData> {
    return this.enqueue(() => this.load());
  }

  private mutate<T>(change: (data: CaseManagementData) => T): Promise<T> {
    return this.enqueue(async () => {
      const data = await this.load();
      const result = change(data);
      await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
      return result;
    });
  }

  private async load(): Promise<CaseManagementData> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (isNotFoundError(err)) return { clients: [], matters: [] };
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Il file del gestionale (${this.filePath}) non contiene JSON valido.`);
    }
    const parsed = CaseManagementDataSchema.safeParse(json);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "radice"))].slice(0, 5);
      throw new Error(`Il file del gestionale (${this.filePath}) non è valido: controllare ${fields.join(", ")}.`);
    }
    return parsed.data;
  }
}

// ---------------------------------------------------------------------------
// Identificativi
// ---------------------------------------------------------------------------

/** Prossimo id libero "<prefisso>-0001". */
function nextId(prefix: string, records: Array<{ id: string }>): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const max = records.reduce((top, r) => Math.max(top, Number(pattern.exec(r.id)?.[1] ?? 0)), 0);
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

/** Numero di pratica "<anno>/<progressivo a 3 cifre nell'anno>". */
function nextMatterNumber(matters: Matter[], year: number): string {
  const max = matters.reduce((top, m) => {
    const match = /^(\d{4})\/(\d+)$/.exec(m.number);
    return match !== null && Number(match[1]) === year ? Math.max(top, Number(match[2])) : top;
  }, 0);
  return `${year}/${String(max + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Ricerca dei clienti
// ---------------------------------------------------------------------------

interface Score {
  score: number;
  matchedOn: ClientMatch["matchedOn"];
}

function scoreClient(client: Client, query: ClientQuery): Score | null {
  const scores = [
    emailScore(client, query),
    phoneScore(client, query),
    nameScore(client, query),
    organizationScore(client, query),
  ];
  return scores.reduce<Score | null>(
    (best, s) => (s !== null && (best === null || s.score > best.score) ? s : best),
    null,
  );
}

function emailScore(client: Client, query: ClientQuery): Score | null {
  const wanted = query.email?.trim().toLowerCase();
  if (!wanted) return null;
  const own = [client.email, client.pec].map((e) => e?.trim().toLowerCase());
  return own.includes(wanted) ? { score: SCORE.email, matchedOn: "email" } : null;
}

function phoneScore(client: Client, query: ClientQuery): Score | null {
  const wanted = digits(query.phone);
  const own = digits(client.phone);
  if (wanted.length < MIN_PHONE_DIGITS || own.length < MIN_PHONE_DIGITS) return null;
  return wanted.slice(-PHONE_DIGITS) === own.slice(-PHONE_DIGITS)
    ? { score: SCORE.phone, matchedOn: "telefono" }
    : null;
}

function nameScore(client: Client, query: ClientQuery): Score | null {
  const wanted = new Set(nameTokens(query.name));
  if (wanted.size === 0 || client.kind !== "persona_fisica") return null;
  const last = nameTokens(client.lastName);
  if (last.length === 0) {
    // Senza cognome separato si confronta il nome visualizzato per intero.
    const display = nameTokens(client.displayName);
    return display.length > 0 && containsAll(wanted, display) ? { score: SCORE.fullName, matchedOn: "nome" } : null;
  }
  if (!containsAll(wanted, last)) return null;
  const first = nameTokens(client.firstName);
  if (first.length > 0 && containsAll(wanted, first)) return { score: SCORE.fullName, matchedOn: "nome" };
  const otherFirstName = first.length > 0 && [...wanted].some((t) => !last.includes(t));
  return { score: otherFirstName ? SCORE.surnameOtherFirstName : SCORE.surname, matchedOn: "nome" };
}

/** Ragione sociale: tutte le parole devono coincidere (titoli e forme societarie esclusi). */
function organizationScore(client: Client, query: ClientQuery): Score | null {
  const company = nameTokens(client.companyName ?? (client.kind === "persona_giuridica" ? client.displayName : null));
  if (company.length === 0) return null;
  const companySet = new Set(company);
  const matches = [query.organization, query.name].some((value) => {
    const wanted = new Set(nameTokens(value));
    return wanted.size === companySet.size && containsAll(wanted, company);
  });
  return matches ? { score: SCORE.organization, matchedOn: "organizzazione" } : null;
}

/** Parole normalizzate: senza accenti, minuscole, senza punti, senza titoli. */
function nameTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "" && !IGNORED_TOKENS.has(t));
}

function containsAll(set: ReadonlySet<string>, tokens: string[]): boolean {
  return tokens.every((t) => set.has(t));
}

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}
