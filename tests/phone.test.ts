import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Extraction, StudioProfile } from "../src/domain/types.js";
import { JsonCaseManagement } from "../src/enrich/json-case-management.js";
import { ExtractionError } from "../src/extract/claude-extractor.js";
import type { ExtractionInput, Extractor } from "../src/extract/extractor.js";
import { buildUserContent } from "../src/extract/prompt.js";
import { callTitle, parseCallFileName } from "../src/phone/call-file-name.js";
import { PhoneInbox, type PhoneUpload } from "../src/phone/phone-inbox.js";
import type { PipelineDeps } from "../src/pipeline.js";
import { createAppServer, type AppServices } from "../src/server/app.js";
import { JsonFileStore } from "../src/store/json-store.js";
import { TranscriptionError, type Transcriber, type TranscriptionInput, type Transcript } from "../src/transcribe/transcriber.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NOW = new Date("2026-10-08T10:00:00Z");

const studio: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone\nStudio Legale Sapone",
};

// ---------------------------------------------------------------------------
// Nome dei file delle chiamate
// ---------------------------------------------------------------------------

describe("parseCallFileName", () => {
  it("legge contatto, numero e ora dai nomi dei file Samsung e di altri telefoni", () => {
    expect(parseCallFileName("Chiamata Mario Rossi_261008_101530.m4a")).toEqual({
      contact: "Mario Rossi",
      phoneNumber: null,
      startedLocal: "2026-10-08T10:15",
    });
    expect(parseCallFileName("Call recording +39 333 123 4567_261008_091500.m4a")).toEqual({
      contact: null,
      phoneNumber: "+393331234567",
      startedLocal: "2026-10-08T09:15",
    });
    expect(parseCallFileName("Registrazione chiamata Avv. Bianchi_261006_160000.m4a").contact).toBe("Avv. Bianchi");
    expect(parseCallFileName("+821012345678_20260601143022.m4a")).toEqual({
      contact: null,
      phoneNumber: "+821012345678",
      startedLocal: "2026-06-01T14:30",
    });
    expect(parseCallFileName("Laura Neri@+39 02 1234567_20261005121533.amr")).toEqual({
      contact: "Laura Neri",
      phoneNumber: "+39021234567",
      startedLocal: "2026-10-05T12:15",
    });
  });

  it("senza data riconoscibile restituisce solo il contatto; date impossibili sono scartate", () => {
    expect(parseCallFileName("Paolo Verdi.m4a")).toEqual({ contact: "Paolo Verdi", phoneNumber: null, startedLocal: null });
    expect(parseCallFileName("Chiamata Paolo Verdi_261345_101530.m4a").startedLocal).toBeNull();
    expect(parseCallFileName("/sdcard/Recordings/Call/Chiamata_261008_101530.m4a")).toEqual({
      contact: null,
      phoneNumber: null,
      startedLocal: "2026-10-08T10:15",
    });
  });

  it("compone un titolo leggibile", () => {
    expect(callTitle({ contact: "Mario Rossi", phoneNumber: null, startedLocal: null })).toBe("Telefonata con Mario Rossi");
    expect(callTitle({ contact: null, phoneNumber: "+393331234567", startedLocal: null })).toBe(
      "Telefonata con +393331234567",
    );
    expect(callTitle({ contact: null, phoneNumber: null, startedLocal: null })).toBe("Telefonata registrata con il telefono");
  });
});

// ---------------------------------------------------------------------------
// Coda delle registrazioni
// ---------------------------------------------------------------------------

/** Trascrizione finta: due voci, oppure un errore programmato. */
class FakeTranscriber implements Transcriber {
  readonly name = "prova";
  readonly calls: TranscriptionInput[] = [];
  failures: Array<TranscriptionError> = [];

  async transcribe(input: TranscriptionInput): Promise<Transcript> {
    this.calls.push(input);
    await stat(input.audioPath); // il file deve esistere durante la trascrizione
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return {
      durationMs: 95_000,
      segments: [
        { startMs: 0, endMs: 4000, speaker: "Speaker 1", text: "Studio Sapone, buongiorno." },
        { startMs: 4000, endMs: 9000, speaker: "Speaker 2", text: "Buongiorno avvocato, sono Mario Rossi." },
        { startMs: 9000, endMs: 9500, speaker: "Speaker 2", text: "   " },
        { startMs: 9500, endMs: 15000, speaker: "Speaker 1", text: "Ci vediamo giovedì alle dieci in studio." },
      ],
    };
  }
}

const EXTRACTION: Extraction = {
  conversationType: "telefonata",
  summary: "Mario Rossi fissa un incontro in studio.",
  participants: [
    {
      name: "Vincenzo Sapone",
      role: "avvocato_studio",
      organization: null,
      email: null,
      phone: null,
      isSpeaker: true,
      speakerLabel: "Speaker 1",
      evidence: [{ segment: 0, quote: "Studio Sapone, buongiorno" }],
    },
    {
      name: "Mario Rossi",
      role: "cliente",
      organization: null,
      email: null,
      phone: null,
      isSpeaker: true,
      speakerLabel: "Speaker 2",
      evidence: [{ segment: 1, quote: "sono Mario Rossi" }],
    },
  ],
  actions: [],
  doubts: [],
} as unknown as Extraction;

class RecordingExtractor implements Extractor {
  readonly name = "prova";
  readonly model = null;
  readonly inputs: ExtractionInput[] = [];
  failures: Error[] = [];

  async extract(input: ExtractionInput): Promise<Extraction> {
    this.inputs.push(input);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return EXTRACTION;
  }
}

interface Env {
  dir: string;
  inboxDir: string;
  deps: PipelineDeps;
  transcriber: FakeTranscriber;
  extractor: RecordingExtractor;
  inbox: PhoneInbox;
}

let env: Env;

async function makeEnv(maxBytes = 1024 * 1024): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), "seguito-phone-"));
  const caseFile = join(dir, "gestionale.json");
  await copyFile(join(FIXTURES, "gestionale.json"), caseFile);
  const extractor = new RecordingExtractor();
  const deps: PipelineDeps = {
    store: new JsonFileStore(join(dir, "data")),
    extractor,
    caseManagement: new JsonCaseManagement(caseFile, { timeZone: "Europe/Rome" }),
    studio,
  };
  const transcriber = new FakeTranscriber();
  const inboxDir = join(dir, "data", "telefono");
  const inbox = new PhoneInbox({
    dir: inboxDir,
    transcriber,
    deps,
    maxBytes,
    now: () => NOW,
    retryDelaysMs: [10, 10],
  });
  return { dir, inboxDir, deps, transcriber, extractor, inbox };
}

beforeEach(async () => {
  env = await makeEnv();
});

afterEach(async () => {
  env.inbox.stop();
  await env.inbox.idle();
  await rm(env.dir, { recursive: true, force: true });
});

function audio(content = "audio di prova m4a"): Readable {
  return Readable.from([Buffer.from(content)]);
}

const META = {
  fileName: "Chiamata Mario Rossi_261008_101530.m4a",
  contentType: "audio/mp4",
  lastModifiedMs: null,
  durationMs: null,
};

async function waitFor(id: string, statuses: PhoneUpload["status"][]): Promise<PhoneUpload> {
  for (let i = 0; i < 200; i++) {
    await env.inbox.idle();
    const upload = await env.inbox.get(id);
    if (upload !== null && statuses.includes(upload.status)) return upload;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Stato atteso non raggiunto per ${id}`);
}

describe("PhoneInbox", () => {
  it("trascrive, analizza e crea la proposta; poi cancella l'audio", async () => {
    const { upload, created } = await env.inbox.receive(audio(), META);
    expect(created).toBe(true);
    expect(upload).toMatchObject({
      status: "ricevuta",
      title: "Telefonata con Mario Rossi",
      contact: "Mario Rossi",
      startedAt: "2026-10-08T08:15:00.000Z",
      sizeBytes: Buffer.byteLength("audio di prova m4a"),
    });
    expect(upload.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await stat(join(env.inboxDir, `${upload.id}.audio`))).mode & 0o777).toBe(0o600);

    const done = await waitFor(upload.id, ["pronta", "errore"]);
    expect(done).toMatchObject({ status: "pronta", proposalId: `telefono:${upload.id}`, durationMs: 95_000 });
    expect(env.transcriber.calls[0]).toMatchObject({ contentType: "audio/mp4", language: "it" });

    const recording = await env.deps.store.getRecording(`telefono:${upload.id}`);
    expect(recording?.source).toBe("telefono");
    expect(recording?.segments.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(recording?.segments[2]?.text).toBe("Ci vediamo giovedì alle dieci in studio.");
    const proposal = await env.deps.store.getProposal(`telefono:${upload.id}`);
    expect(proposal?.recording.source).toBe("telefono");
    expect(proposal?.participants.find((p) => p.role === "cliente")?.clientMatch?.displayName).toBe("Mario Rossi");

    // Sul server resta solo il testo.
    expect((await readdir(env.inboxDir)).filter((n) => n.endsWith(".audio"))).toEqual([]);
    // Il modello sa che la registrazione viene dal telefono.
    const content = buildUserContent(env.extractor.inputs[0] as ExtractionInput);
    expect(content).toContain("TITOLO: Telefonata con Mario Rossi");
    expect(content).toContain("FONTE: chiamata registrata con il telefono dell'avvocato");
  });

  it("riconosce lo stesso audio inviato due volte", async () => {
    const first = await env.inbox.receive(audio("stesso audio"), META);
    const second = await env.inbox.receive(audio("stesso audio"), { ...META, fileName: "altro nome.m4a" });
    expect(second.created).toBe(false);
    expect(second.upload.id).toBe(first.upload.id);
    await waitFor(first.upload.id, ["pronta"]);
    expect(env.transcriber.calls).toHaveLength(1);
  });

  it("senza data nel nome usa la data del file meno la durata", async () => {
    const { upload } = await env.inbox.receive(audio("x"), {
      fileName: "registrazione.m4a",
      contentType: "audio/mp4",
      lastModifiedMs: Date.parse("2026-10-08T09:00:00Z"),
      durationMs: 60_000,
    });
    expect(upload.startedAt).toBe("2026-10-08T08:59:00.000Z");
    expect(upload.title).toBe("Telefonata registrata con il telefono");
  });

  it("rifiuta file vuoti o troppo grandi senza lasciare file temporanei", async () => {
    await expect(env.inbox.receive(audio(""), META)).rejects.toMatchObject({ name: "PhoneUploadError", status: 400 });
    const small = await makeEnv(10);
    try {
      await expect(small.inbox.receive(audio("più di dieci byte"), META)).rejects.toMatchObject({ status: 413 });
      expect(await readdir(small.inboxDir)).toEqual([]);
    } finally {
      await rm(small.dir, { recursive: true, force: true });
    }
  });

  it("ritenta gli errori transitori e si ferma su quelli definitivi", async () => {
    env.transcriber.failures = [new TranscriptionError("Servizio non raggiungibile.", true)];
    const { upload } = await env.inbox.receive(audio("a"), META);
    const done = await waitFor(upload.id, ["pronta", "errore"]);
    expect(done.status).toBe("pronta");
    expect(env.transcriber.calls).toHaveLength(2);

    env.transcriber.failures = [new TranscriptionError("Formato audio non supportato.", false)];
    const bad = await env.inbox.receive(audio("b"), META);
    const failed = await waitFor(bad.upload.id, ["errore"]);
    expect(failed.message).toBe("Formato audio non supportato.");
    // L'audio resta finché non riesce: «riprova» lo trascrive di nuovo.
    await env.inbox.retry(bad.upload.id);
    expect((await waitFor(bad.upload.id, ["pronta"])).status).toBe("pronta");
  });

  it("dopo un'analisi non riuscita riprova senza trascrivere di nuovo", async () => {
    env.extractor.failures = [new ExtractionError("Il servizio di analisi non risponde.", { retryable: true })];
    const { upload } = await env.inbox.receive(audio("c"), META);
    const done = await waitFor(upload.id, ["pronta", "errore"]);
    expect(done.status).toBe("pronta");
    expect(env.transcriber.calls).toHaveLength(1);
    expect(env.extractor.inputs).toHaveLength(2);
  });

  it("segnala una trascrizione vuota come errore definitivo", async () => {
    env.transcriber.transcribe = async () => ({ durationMs: 1000, segments: [] });
    const { upload } = await env.inbox.receive(audio("d"), META);
    const failed = await waitFor(upload.id, ["errore"]);
    expect(failed.message).toMatch(/trascrizione è vuota/);
  });

  it("riprende all'avvio le registrazioni rimaste in coda", async () => {
    const { upload } = await env.inbox.receive(audio("e"), META);
    await waitFor(upload.id, ["pronta"]);
    const restarted = new PhoneInbox({
      dir: env.inboxDir,
      transcriber: env.transcriber,
      deps: env.deps,
      maxBytes: 1024,
      now: () => NOW,
    });
    await restarted.resume();
    await restarted.idle();
    expect(env.transcriber.calls).toHaveLength(1);
    expect(await restarted.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rotte del server
// ---------------------------------------------------------------------------

interface Running {
  port: number;
  close(): Promise<void>;
}

async function start(services: AppServices): Promise<Running> {
  const server: Server = createAppServer(services);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<{ status: number; json: () => Record<string, unknown> }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...headers, ...(body ? { "Content-Length": String(body.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolvePromise({ status: res.statusCode ?? 0, json: () => JSON.parse(text) as Record<string, unknown> });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const AUTH = { Authorization: `Basic ${Buffer.from("telefono:parola-segreta").toString("base64")}` };

function services(overrides: Partial<AppServices> = {}): AppServices {
  return {
    store: env.deps.store,
    studio,
    outboxDir: env.dir,
    password: "parola-segreta",
    approve: async () => {
      throw new Error("non usato");
    },
    discard: async () => {
      throw new Error("non usato");
    },
    phone: {
      maxBytes: 1024,
      receive: (body, meta) => env.inbox.receive(body, meta),
      get: (id) => env.inbox.get(id),
      list: () => env.inbox.list(),
      retry: (id) => env.inbox.retry(id),
    },
    ...overrides,
  };
}

describe("rotte /api/telefono/registrazioni", () => {
  it("riceve l'audio con la password, poi ne mostra lo stato e l'elenco", async () => {
    const server = await start(services());
    try {
      const name = encodeURIComponent("Chiamata Mario Rossi_261008_101530.m4a");
      const body = Buffer.from("audio dal telefono");
      const sent = await send(
        server.port,
        "POST",
        `/api/telefono/registrazioni?nome=${name}&modificato=1791451200000&durata=60000`,
        { ...AUTH, "Content-Type": "audio/mp4" },
        body,
      );
      expect(sent.status).toBe(201);
      const view = sent.json();
      expect(view).toMatchObject({ title: "Telefonata con Mario Rossi", status: "ricevuta" });
      expect(Object.keys(view).sort()).toEqual(
        ["id", "message", "nextAttemptAt", "proposalId", "receivedAt", "startedAt", "status", "title"].sort(),
      );
      const again = await send(
        server.port,
        "POST",
        `/api/telefono/registrazioni?nome=${name}`,
        { ...AUTH, "Content-Type": "audio/mp4" },
        body,
      );
      expect(again.status).toBe(200);

      await waitFor(String(view.id), ["pronta"]);
      const status = await send(server.port, "GET", `/api/telefono/registrazioni/${String(view.id)}`, AUTH);
      expect(status.json()).toMatchObject({ status: "pronta", proposalId: `telefono:${String(view.id)}` });
      const list = await send(server.port, "GET", "/api/telefono/registrazioni/elenco", AUTH);
      expect(list.status).toBe(200);
      const missing = await send(server.port, "GET", `/api/telefono/registrazioni/${"0".repeat(32)}`, AUTH);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("rifiuta invii senza password configurata, senza credenziali, non audio o da altre origini", async () => {
    const body = Buffer.from("audio");
    const path = "/api/telefono/registrazioni?nome=a.m4a";
    const noPassword = await start(services({ password: null }));
    try {
      const r = await send(noPassword.port, "POST", path, { "Content-Type": "audio/mp4" }, body);
      expect(r.status).toBe(403);
      expect(r.json().error).toMatch(/SEGUITO_PASSWORD/);
    } finally {
      await noPassword.close();
    }
    const server = await start(services());
    try {
      expect((await send(server.port, "POST", path, { "Content-Type": "audio/mp4" }, body)).status).toBe(401);
      expect((await send(server.port, "POST", path, { ...AUTH, "Content-Type": "text/plain" }, body)).status).toBe(415);
      const cross = await send(
        server.port,
        "POST",
        path,
        { ...AUTH, "Content-Type": "audio/mp4", Origin: "https://sito-esterno.example" },
        body,
      );
      expect(cross.status).toBe(403);
      const noName = await send(server.port, "POST", "/api/telefono/registrazioni", { ...AUTH, "Content-Type": "audio/mp4" }, body);
      expect(noName.status).toBe(400);
      const tooBig = await send(server.port, "POST", path, { ...AUTH, "Content-Type": "audio/mp4" }, Buffer.alloc(2048));
      expect(tooBig.status).toBe(413);
      expect((await readdir(env.inboxDir).catch(() => [])).filter((n) => n.endsWith(".audio"))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("risponde 503 se la ricezione dal telefono non è configurata", async () => {
    const server = await start(services({ phone: undefined }));
    try {
      const r = await send(server.port, "POST", "/api/telefono/registrazioni?nome=a.m4a", { ...AUTH, "Content-Type": "audio/mp4" }, Buffer.from("x"));
      expect(r.status).toBe(503);
      expect((await send(server.port, "GET", "/api/config", AUTH)).json().phoneAvailable).toBe(false);
    } finally {
      await server.close();
    }
  });
});
