import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProposalSchema,
  RecordingSchema,
  type ApprovalRequest,
  type Proposal,
  type ProposedAction,
  type Recording,
  type Segment,
  type StudioProfile,
} from "../src/domain/types.js";
import { createAppServer, type AppServices } from "../src/server/app.js";
import type { Store } from "../src/store/store.js";

// ---------------------------------------------------------------------------
// Dati e servizi finti
// ---------------------------------------------------------------------------

const STUDIO: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone\nStudio Legale Sapone",
};

const ROSSI_ID = "plaud:rossi-0001";
const BIANCHI_ID = "plaud:bianchi-0002";
const DISCARDED_ID = "plaud:verdi-0003";

class MemoryStore implements Store {
  readonly recordings = new Map<string, Recording>();
  readonly proposals = new Map<string, Proposal>();
  private readonly checkpoints = new Map<string, string>();

  async saveRecording(recording: Recording): Promise<void> {
    this.recordings.set(recording.id, recording);
  }
  async getRecording(id: string): Promise<Recording | null> {
    return this.recordings.get(id) ?? null;
  }
  async hasRecording(id: string): Promise<boolean> {
    return this.recordings.has(id);
  }
  async saveProposal(proposal: Proposal): Promise<void> {
    this.proposals.set(proposal.id, proposal);
  }
  async createProposal(proposal: Proposal): Promise<boolean> {
    if (this.proposals.has(proposal.id)) return false;
    this.proposals.set(proposal.id, proposal);
    return true;
  }
  async getProposal(id: string): Promise<Proposal | null> {
    return this.proposals.get(id) ?? null;
  }
  async listProposals(): Promise<Proposal[]> {
    return [...this.proposals.values()].sort((a, b) => b.recording.startedAt.localeCompare(a.recording.startedAt));
  }
  async getCheckpoint(key: string): Promise<string | null> {
    return this.checkpoints.get(key) ?? null;
  }
  async setCheckpoint(key: string, value: string): Promise<void> {
    this.checkpoints.set(key, value);
  }
}

function makeRecording(id: string, startedAt: string): Recording {
  return RecordingSchema.parse({
    id,
    source: "plaud",
    externalId: id.split(":")[1],
    title: "Telefonata Rossi",
    startedAt,
    durationMs: 420_000,
    segments: [
      { index: 0, startMs: 0, endMs: 5000, speaker: "Speaker 1", text: "Buongiorno, sono l'avvocato Sapone." },
      { index: 1, startMs: 5000, endMs: 12000, speaker: "Speaker 2", text: "Ci vediamo giovedì alle dieci in studio." },
    ],
    plaudSummary: null,
    fetchedAt: startedAt,
  });
}

function action(id: string, preselected: boolean, payload: ProposedAction["payload"], warnings: ProposedAction["warnings"] = []): ProposedAction {
  return {
    id,
    origin: payload.type === "invio_trascrizione" ? "sistema" : "modello",
    payload,
    confidence: 0.9,
    evidence: [{ segment: 1, quote: "giovedì alle dieci", startMs: 5000, speaker: "Speaker 2", verified: true }],
    rationale: "Concordato durante la telefonata.",
    preselected,
    warnings,
  };
}

function makeProposal(id: string, startedAt: string, overrides: Partial<Proposal> = {}): Proposal {
  return ProposalSchema.parse({
    id,
    recordingId: id,
    createdAt: startedAt,
    updatedAt: startedAt,
    status: "da_revisionare",
    recording: { title: `Registrazione ${id}`, startedAt, durationMs: 420_000, source: "plaud" },
    conversationType: "telefonata",
    summary: "Primo contatto: fissato un incontro in studio.",
    participants: [],
    actions: [
      action("a1", true, {
        type: "appuntamento",
        title: "Primo incontro in studio",
        status: "fissato",
        start: "2026-10-15T10:00",
        durationMinutes: 60,
        location: "Studio di Cantù",
        mode: "in_studio",
        participants: ["Mario Rossi"],
        notes: null,
      }),
      action(
        "a2",
        false,
        {
          type: "scadenza",
          title: "Termine per l'opposizione",
          date: "2026-11-11",
          time: null,
          kind: "processuale",
          legalBasis: "art. 641 c.p.c.",
          computation: "notifica 02/10/2026 + 40 giorni",
          notes: null,
        },
        [{ code: "TERMINE_DA_VERIFICARE", severity: "attenzione", message: "Termine calcolato automaticamente: verificare." }],
      ),
      action("a3", true, { type: "invio_trascrizione", to: STUDIO.studioEmail }),
    ],
    doubts: [],
    warnings: [],
    extractor: { name: "fixture", model: null },
    executions: [],
    ...overrides,
  });
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

interface Harness {
  store: MemoryStore;
  services: AppServices;
  approveCalls: Array<{ id: string; request: ApprovalRequest }>;
}

function createHarness(outboxDir: string, overrides: Partial<AppServices> = {}): Harness {
  const store = new MemoryStore();
  const rossi = makeProposal(ROSSI_ID, "2026-10-07T07:30:00.000Z");
  const bianchi = makeProposal(BIANCHI_ID, "2026-10-06T15:00:00.000Z", {
    warnings: [{ code: "COLLEGA_ART38", severity: "bloccante", message: "Conversazione telefonica con un collega." }],
    actions: rossi.actions.map((item) => ({ ...item, preselected: false })),
  });
  const discarded = makeProposal(DISCARDED_ID, "2026-10-05T09:00:00.000Z", { status: "scartata" });
  for (const proposal of [bianchi, rossi, discarded]) store.proposals.set(proposal.id, proposal);
  store.recordings.set(ROSSI_ID, makeRecording(ROSSI_ID, "2026-10-07T07:30:00.000Z"));

  const approveCalls: Harness["approveCalls"] = [];
  const services: AppServices = {
    store,
    studio: STUDIO,
    outboxDir,
    password: null,
    async approve(id, approval) {
      approveCalls.push({ id, request: approval });
      const proposal = await store.getProposal(id);
      if (proposal === null) throw new Error("Proposta inesistente");
      if (proposal.status === "scartata" || proposal.status === "eseguita") {
        throw namedError("ProposalStateError", "La proposta è già stata chiusa e non può essere approvata.");
      }
      const unknown = approval.actionIds.filter((actionId) => !proposal.actions.some((item) => item.id === actionId));
      if (unknown.length > 0) throw namedError("ApprovalValidationError", `Azioni sconosciute: ${unknown.join(", ")}.`);
      const updated: Proposal = {
        ...proposal,
        status: "eseguita",
        executions: approval.actionIds.map((actionId) => ({
          actionId,
          executedAt: "2026-10-07T08:00:00.000Z",
          status: "ok" as const,
          message: "Eseguita",
          artifacts: [],
        })),
      };
      await store.saveProposal(updated);
      return updated;
    },
    async discard(id) {
      const proposal = await store.getProposal(id);
      if (proposal === null) throw new Error("Proposta inesistente");
      if (proposal.status !== "da_revisionare") {
        throw namedError("ProposalStateError", "Si possono scartare solo le proposte da revisionare.");
      }
      const updated: Proposal = { ...proposal, status: "scartata" };
      await store.saveProposal(updated);
      return updated;
    },
    ...overrides,
  };
  return { store, services, approveCalls };
}

// ---------------------------------------------------------------------------
// Client HTTP grezzo: i percorsi vengono inviati così come sono (niente normalizzazione)
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json<T = ErrorBody>(): T;
}

interface ErrorBody {
  error: string;
}

interface DetailBody {
  proposal: Proposal;
  transcript: { title: string; startedAt: string; segments: Segment[] };
}

interface RunningServer {
  port: number;
  close(): Promise<void>;
}

async function start(services: AppServices): Promise<RunningServer> {
  const server: Server = createAppServer(services);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (options.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(options.body));
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const text = body.toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: <T>() => JSON.parse(text) as T });
      });
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return send(port, "POST", path, {
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const proposalPath = (id: string, suffix = ""): string => `/api/proposals/${encodeURIComponent(id)}${suffix}`;

function expectSecurityHeaders(response: RawResponse): void {
  expect(response.headers["content-security-policy"]).toBe(
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["x-frame-options"]).toBe("DENY");
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

let root: string;
let outboxDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "seguito-server-"));
  outboxDir = join(root, "outbox");
  const proposalDir = join(outboxDir, "plaud-rossi-0001");
  await mkdir(proposalDir, { recursive: true });
  await writeFile(join(proposalDir, "a1-primo-incontro.ics"), "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  await writeFile(join(proposalDir, "a3-trascrizione.eml"), "Subject: Trascrizione\r\nX-Unsent: 1\r\n\r\nTesto\r\n");
  await writeFile(join(proposalDir, "udienza-è.ics"), "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  await writeFile(join(proposalDir, ".tmp-123"), "temporaneo");
  await writeFile(join(root, "secret.txt"), "SEGRETO");
  await symlink(join(root, "secret.txt"), join(proposalDir, "collegamento.ics"));
  await symlink(root, join(outboxDir, "fuori"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("server senza password", () => {
  let harness: Harness;
  let server: RunningServer;

  beforeEach(async () => {
    harness = createHarness(outboxDir);
    server = await start(harness.services);
  });

  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
  });

  it("risponde a /api/health con intestazioni di sicurezza e no-store", async () => {
    const response = await send(server.port, "GET", "/api/health");
    expect(response.status).toBe(200);
    expect(response.json<unknown>()).toEqual({ ok: true });
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(response);
  });

  it("espone la configurazione pubblica", async () => {
    const response = await send(server.port, "GET", "/api/config");
    expect(response.json<unknown>()).toEqual({
      studioName: STUDIO.studioName,
      lawyerName: STUDIO.lawyerName,
      timezone: "Europe/Rome",
      syncAvailable: false,
      microsoft365: null,
    });
  });

  it("elenca le proposte dalla più recente con i riepiloghi", async () => {
    const response = await send(server.port, "GET", "/api/proposals");
    expect(response.status).toBe(200);
    const list = response.json<Array<Record<string, unknown>>>();
    expect(list.map((item) => item.id)).toEqual([ROSSI_ID, BIANCHI_ID, DISCARDED_ID]);
    expect(list[0]).toEqual({
      id: ROSSI_ID,
      status: "da_revisionare",
      title: `Registrazione ${ROSSI_ID}`,
      startedAt: "2026-10-07T07:30:00.000Z",
      durationMs: 420_000,
      conversationType: "telefonata",
      summary: "Primo contatto: fissato un incontro in studio.",
      actionsCount: 3,
      preselectedCount: 2,
      warningCodes: ["TERMINE_DA_VERIFICARE"],
      hasBlocking: false,
      pendingDeadlines: 1,
    });
    expect(list[1]).toMatchObject({
      preselectedCount: 0,
      warningCodes: ["COLLEGA_ART38", "TERMINE_DA_VERIFICARE"],
      hasBlocking: true,
    });
  });

  it("restituisce il dettaglio con la trascrizione (id con ':' codificato o no)", async () => {
    for (const path of [proposalPath(ROSSI_ID), `/api/proposals/${ROSSI_ID}`]) {
      const response = await send(server.port, "GET", path);
      expect(response.status).toBe(200);
      const body = response.json<DetailBody>();
      expect(body.proposal.id).toBe(ROSSI_ID);
      expect(body.transcript.title).toBe("Telefonata Rossi");
      expect(body.transcript.segments).toHaveLength(2);
      expect(body.transcript.segments[1]?.text).toBe("Ci vediamo giovedì alle dieci in studio.");
    }
  });

  it("restituisce segmenti vuoti se la registrazione non è in archivio", async () => {
    const body = (await send(server.port, "GET", proposalPath(BIANCHI_ID))).json<DetailBody>();
    expect(body.transcript).toEqual({
      title: `Registrazione ${BIANCHI_ID}`,
      startedAt: "2026-10-06T15:00:00.000Z",
      segments: [],
    });
  });

  it("risponde 404 in italiano per proposte e percorsi inesistenti", async () => {
    const missing = await send(server.port, "GET", proposalPath("plaud:inesistente"));
    expect(missing.status).toBe(404);
    expect(missing.json()).toEqual({ error: "Proposta non trovata." });
    const unknown = await send(server.port, "GET", "/api/sconosciuto");
    expect(unknown.status).toBe(404);
    expectSecurityHeaders(unknown);
    expect((await send(server.port, "GET", "/api/proposals/%E0%A4%A")).status).toBe(400);
  });

  it("approva con un corpo valido e passa id e richiesta ai servizi", async () => {
    const approval = { actionIds: ["a1", "a3"], edits: { a1: { location: "Studio di Como" } } };
    const response = await postJson(server.port, proposalPath(ROSSI_ID, "/approve"), approval);
    expect(response.status).toBe(200);
    const proposal = ProposalSchema.parse(response.json<unknown>());
    expect(proposal.status).toBe("eseguita");
    expect(proposal.executions.map((result) => result.actionId)).toEqual(["a1", "a3"]);
    expect(harness.approveCalls).toEqual([{ id: ROSSI_ID, request: approval }]);
  });

  it("rifiuta corpi di approvazione non validi con 400", async () => {
    const path = proposalPath(ROSSI_ID, "/approve");
    const wrongShape = await postJson(server.port, path, { actionIds: "a1" });
    expect(wrongShape.status).toBe(400);
    expect(wrongShape.json().error).toContain("actionIds");
    const malformed = await send(server.port, "POST", path, {
      headers: { "Content-Type": "application/json" },
      body: "{non json",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.json()).toEqual({ error: "Il corpo della richiesta non è un JSON valido." });
    const empty = await postJson(server.port, path, { actionIds: [] });
    expect(empty.status).toBe(400);
    expect(harness.approveCalls).toHaveLength(0);
  });

  it("mappa ApprovalValidationError su 400 e ProposalStateError su 409", async () => {
    const invalid = await postJson(server.port, proposalPath(ROSSI_ID, "/approve"), { actionIds: ["a9"] });
    expect(invalid.status).toBe(400);
    expect(invalid.json()).toEqual({ error: "Azioni sconosciute: a9." });
    const conflict = await postJson(server.port, proposalPath(DISCARDED_ID, "/approve"), { actionIds: ["a1"] });
    expect(conflict.status).toBe(409);
    expect(conflict.json()).toEqual({ error: "La proposta è già stata chiusa e non può essere approvata." });
  });

  it("non espone i dettagli degli errori interni", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await server.close();
    harness = createHarness(outboxDir, {
      approve: async () => {
        throw new Error("Errore con dati riservati del cliente Mario Rossi");
      },
    });
    server = await start(harness.services);
    const response = await postJson(server.port, proposalPath(ROSSI_ID, "/approve"), { actionIds: ["a1"] });
    expect(response.status).toBe(500);
    expect(response.text).not.toContain("Rossi");
    expect(response.text).not.toContain(" at ");
    expect(response.json().error).toMatch(/errore interno/i);
    expect(logged).toHaveBeenCalled();
  });

  it("impedisce due operazioni contemporanee sulla stessa proposta", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const original = harness.services.approve.bind(harness.services);
    harness.services.approve = async (id, approval) => {
      entered = true;
      await gate;
      return original(id, approval);
    };
    const first = postJson(server.port, proposalPath(ROSSI_ID, "/approve"), { actionIds: ["a1"] });
    await vi.waitFor(() => expect(entered).toBe(true));
    const second = await postJson(server.port, proposalPath(ROSSI_ID, "/approve"), { actionIds: ["a1"] });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("accetta solo POST JSON dalla stessa origine e con corpo entro 1 MB", async () => {
    const path = proposalPath(ROSSI_ID, "/approve");
    const notJson = await send(server.port, "POST", path, {
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ actionIds: ["a1"] }),
    });
    expect(notJson.status).toBe(415);
    const crossOrigin = await postJson(server.port, path, { actionIds: ["a1"] }, { Origin: "https://attacker.example" });
    expect(crossOrigin.status).toBe(403);
    const tooLarge = await postJson(server.port, path, { actionIds: ["a1"], padding: "x".repeat(1024 * 1024) });
    expect(tooLarge.status).toBe(413);
    expect(harness.approveCalls).toHaveLength(0);
    const sameOrigin = await postJson(
      server.port,
      path,
      { actionIds: ["a1"] },
      { Origin: `http://127.0.0.1:${server.port}` },
    );
    expect(sameOrigin.status).toBe(200);
  });

  it("scarta una proposta e rifiuta lo scarto ripetuto con 409", async () => {
    const response = await postJson(server.port, proposalPath(ROSSI_ID, "/discard"), {});
    expect(response.status).toBe(200);
    expect(response.json<Proposal>().status).toBe("scartata");
    const detail = (await send(server.port, "GET", proposalPath(ROSSI_ID))).json<DetailBody>();
    expect(detail.proposal.status).toBe("scartata");
    expect((await postJson(server.port, proposalPath(ROSSI_ID, "/discard"), {})).status).toBe(409);
    expect((await postJson(server.port, proposalPath("plaud:inesistente", "/discard"), {})).status).toBe(404);
  });

  it("rifiuta i nomi host non autorizzati (DNS rebinding), prima di ogni altra verifica", async () => {
    const path = proposalPath(ROSSI_ID, "/approve");
    for (const host of ["evil.example:3000", "127.0.0.1.nip.io", "evil.example@127.0.0.1", "localhost.evil.example"]) {
      const read = await send(server.port, "GET", "/api/proposals", { headers: { Host: host } });
      expect(read.status, host).toBe(403);
      expect(read.json().error).toMatch(/nome host non autorizzato.*SEGUITO_ALLOWED_HOSTS/);
      expect(read.text).not.toContain(ROSSI_ID);
    }
    const forged = await postJson(
      server.port,
      path,
      { actionIds: ["a1"] },
      { Host: "evil.example:3000", Origin: "http://evil.example:3000" },
    );
    expect(forged.status).toBe(403);
    expect(harness.approveCalls).toHaveLength(0);
    for (const host of [`localhost:${server.port}`, `LOCALHOST:${server.port}`, `[::1]:${server.port}`, "192.168.1.20:3000"]) {
      expect((await send(server.port, "GET", "/api/health", { headers: { Host: host } })).status, host).toBe(200);
    }
  });

  it("risponde 405 ai metodi non ammessi", async () => {
    const getApprove = await send(server.port, "GET", proposalPath(ROSSI_ID, "/approve"));
    expect(getApprove.status).toBe(405);
    expect(getApprove.headers.allow).toBe("POST");
    const deleteList = await send(server.port, "DELETE", "/api/proposals");
    expect(deleteList.status).toBe(405);
    expect(deleteList.headers.allow).toBe("GET, HEAD");
  });

  it("risponde 404 a /api/sync quando la sincronizzazione non è configurata", async () => {
    const response = await postJson(server.port, "/api/sync", {});
    expect(response.status).toBe(404);
    expect(response.json().error).toMatch(/sincronizzazione/i);
  });

  it("serve i file dell'outbox come download", async () => {
    const ics = await send(server.port, "GET", "/outbox/plaud-rossi-0001/a1-primo-incontro.ics");
    expect(ics.status).toBe(200);
    expect(ics.headers["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(ics.headers["content-disposition"]).toBe(
      "attachment; filename=\"a1-primo-incontro.ics\"; filename*=UTF-8''a1-primo-incontro.ics",
    );
    expect(ics.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(ics);
    expect(ics.text).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");

    const eml = await send(server.port, "GET", "/outbox/plaud-rossi-0001/a3-trascrizione.eml");
    expect(eml.status).toBe(200);
    expect(eml.headers["content-type"]).toBe("message/rfc822");
    expect(eml.text).toContain("X-Unsent: 1");

    const accented = await send(server.port, "GET", `/outbox/plaud-rossi-0001/${encodeURIComponent("udienza-è.ics")}`);
    expect(accented.status).toBe(200);
    expect(accented.headers["content-disposition"]).toBe(
      "attachment; filename=\"udienza-_.ics\"; filename*=UTF-8''udienza-%C3%A8.ics",
    );
  });

  it("blocca i tentativi di uscire dalla cartella outbox", async () => {
    const attempts = [
      "/outbox/../secret.txt",
      "/outbox/plaud-rossi-0001/../../secret.txt",
      "/outbox/%2e%2e/secret.txt",
      "/outbox/%2E%2E%2Fsecret.txt",
      "/outbox/plaud-rossi-0001/..%2F..%2Fsecret.txt",
      "/outbox/..%5Csecret.txt",
      "/outbox//etc/passwd",
      `/outbox/${encodeURIComponent(join(root, "secret.txt"))}`,
      "/outbox/%2Fetc%2Fpasswd",
      "/outbox/plaud-rossi-0001/collegamento.ics",
      "/outbox/fuori/secret.txt",
      "/outbox/plaud-rossi-0001/.tmp-123",
      "/outbox/plaud-rossi-0001/a1-primo-incontro.ics%00.txt",
    ];
    for (const path of attempts) {
      const response = await send(server.port, "GET", path);
      expect([400, 404], path).toContain(response.status);
      expect(response.text, path).not.toContain("SEGRETO");
      expect(response.headers["content-type"], path).toBe("application/json; charset=utf-8");
    }
    expect((await send(server.port, "GET", "/outbox/plaud-rossi-0001/inesistente.ics")).status).toBe(404);
    expect((await send(server.port, "GET", "/outbox/plaud-rossi-0001")).status).toBe(404);
  });

  it("serve l'interfaccia e i file statici con i tipi corretti", async () => {
    const expected: Record<string, string> = {
      "/": "text/html; charset=utf-8",
      "/static/app.js": "text/javascript; charset=utf-8",
      "/static/styles.css": "text/css; charset=utf-8",
      "/static/manifest.webmanifest": "application/manifest+json",
      "/static/icon.svg": "image/svg+xml",
    };
    for (const [path, contentType] of Object.entries(expected)) {
      const response = await send(server.port, "GET", path);
      expect(response.status, path).toBe(200);
      expect(response.headers["content-type"], path).toBe(contentType);
      expectSecurityHeaders(response);
    }
    const manifest = (await send(server.port, "GET", "/static/manifest.webmanifest")).json<unknown>();
    expect(manifest).toMatchObject({ name: "Seguito", short_name: "Seguito", display: "standalone" });
    const head = await send(server.port, "HEAD", "/");
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
    for (const path of ["/static/app.ts", "/static/../app.ts", "/static/%2e%2e%2fapp.ts", "/static/", "/ui/app.js"]) {
      expect((await send(server.port, "GET", path)).status, path).toBe(404);
    }
  });

  it("l'interfaccia rispetta la CSP e non usa innerHTML", async () => {
    const html = (await send(server.port, "GET", "/")).text;
    expect(html).toContain('<script type="module" src="/static/app.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    const script = await readFile(new URL("../src/server/ui/app.js", import.meta.url), "utf8");
    expect(script).not.toMatch(/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\(|document\.write\(|\beval\(/);
  });
});

describe("server con sincronizzazione", () => {
  it("dichiara la sincronizzazione e la esegue una volta per richieste concorrenti", async () => {
    let runs = 0;
    const harness = createHarness(outboxDir, {
      sync: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { processed: 2, skipped: 1, errors: [] };
      },
    });
    const server = await start(harness.services);
    try {
      expect((await send(server.port, "GET", "/api/config")).json<{ syncAvailable: boolean }>().syncAvailable).toBe(true);
      const [first, second] = await Promise.all([
        postJson(server.port, "/api/sync", {}),
        postJson(server.port, "/api/sync", {}),
      ]);
      expect(first.status).toBe(200);
      expect(first.json<unknown>()).toEqual({ processed: 2, skipped: 1, errors: [] });
      expect(second.json<unknown>()).toEqual({ processed: 2, skipped: 1, errors: [] });
      expect(runs).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe("server con Microsoft 365", () => {
  function microsoftHarness(complete: (query: URLSearchParams) => Promise<string>) {
    const calls = { complete: [] as string[], disconnect: 0 };
    let connected = false;
    const harness = createHarness(outboxDir, {
      microsoft365: {
        redirectOrigin: "http://localhost:3000",
        status: async () => ({ connected, account: connected ? "avvocato@studio.example" : null }),
        authorizationUrl: () => "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=abc",
        complete: async (query) => {
          calls.complete.push(query.toString());
          const account = await complete(query);
          connected = true;
          return account;
        },
        disconnect: async () => {
          calls.disconnect += 1;
          connected = false;
        },
      },
    });
    return { harness, calls };
  }

  it("avvia l'accesso, completa il ritorno e mostra lo stato del collegamento", async () => {
    const { harness, calls } = microsoftHarness(async () => "avvocato@studio.example");
    const server = await start(harness.services);
    try {
      const before = (await send(server.port, "GET", "/api/config")).json<{ microsoft365: unknown }>();
      expect(before.microsoft365).toEqual({ connected: false, account: null, redirectOrigin: "http://localhost:3000" });

      // Una pagina esterna non può avviare richieste di accesso.
      for (const site of ["cross-site", "same-site"]) {
        const blocked = await send(server.port, "GET", "/auth/microsoft", { headers: { "Sec-Fetch-Site": site } });
        expect(blocked.status, site).toBe(403);
      }
      const typed = await send(server.port, "GET", "/auth/microsoft", { headers: { "Sec-Fetch-Site": "none" } });
      expect(typed.status).toBe(302);

      const login = await send(server.port, "GET", "/auth/microsoft", { headers: { "Sec-Fetch-Site": "same-origin" } });
      expect(login.status).toBe(302);
      expect(login.headers.location).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=abc");
      expectSecurityHeaders(login);

      const back = await send(server.port, "GET", "/auth/microsoft/callback?code=CODICE&state=abc");
      expect(back.status).toBe(302);
      expect(back.headers.location).toBe("/?microsoft365=collegato");
      expect(calls.complete).toEqual(["code=CODICE&state=abc"]);

      const after = (await send(server.port, "GET", "/api/config")).json<{ microsoft365: unknown }>();
      expect(after.microsoft365).toEqual({
        connected: true,
        account: "avvocato@studio.example",
        redirectOrigin: "http://localhost:3000",
      });

      const disconnect = await postJson(server.port, "/api/microsoft365/disconnect", {});
      expect(disconnect.status).toBe(200);
      expect(calls.disconnect).toBe(1);
      expect((await send(server.port, "GET", "/api/microsoft365/disconnect")).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("comunica all'interfaccia solo un codice d'esito, mai il testo dell'errore", async () => {
    const failure = (reason: string) => () => {
      const error = new Error("dettaglio interno da non mostrare") as Error & { reason?: string };
      error.name = "Microsoft365AuthError";
      error.reason = reason;
      return Promise.reject(error);
    };
    const cases: Array<[string, string]> = [
      ["annullato", "/?microsoft365=annullato"],
      ["scaduto", "/?microsoft365=scaduto"],
      ["configurazione", "/?microsoft365=configurazione"],
      ["inventato", "/?microsoft365=errore"],
    ];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const [reason, location] of cases) {
        const { harness } = microsoftHarness(failure(reason));
        const server = await start(harness.services);
        try {
          const back = await send(server.port, "GET", "/auth/microsoft/callback?error=access_denied&state=abc");
          expect(back.status).toBe(302);
          expect(back.headers.location).toBe(location);
          expect(back.text).not.toContain("dettaglio");
        } finally {
          await server.close();
        }
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("risponde 404 alle rotte di Microsoft 365 quando non è configurato", async () => {
    const server = await start(createHarness(outboxDir).services);
    try {
      for (const path of ["/auth/microsoft", "/auth/microsoft/callback?code=x&state=y"]) {
        const response = await send(server.port, "GET", path);
        expect(response.status, path).toBe(404);
        expect(response.json().error).toMatch(/SEGUITO_M365_TENANT_ID/);
      }
      expect((await postJson(server.port, "/api/microsoft365/disconnect", {})).status).toBe(404);
      expect((await send(server.port, "GET", "/auth/microsoft/altro")).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("server con nomi host autorizzati", () => {
  it("accetta i nomi configurati, senza distinzione tra maiuscole e minuscole", async () => {
    const harness = createHarness(outboxDir, { allowedHosts: ["Seguito.Studio.lan"] });
    const server = await start(harness.services);
    try {
      const ok = await send(server.port, "GET", "/api/proposals", { headers: { Host: "seguito.studio.lan:3000" } });
      expect(ok.status).toBe(200);
      const other = await send(server.port, "GET", "/api/proposals", { headers: { Host: "altro.studio.lan:3000" } });
      expect(other.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe("server con password", () => {
  let server: RunningServer;
  const basic = (user: string, password: string): string =>
    `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

  beforeAll(async () => {
    server = await start(createHarness(outboxDir, { password: "parola-segreta" }).services);
  });

  afterAll(async () => {
    await server.close();
  });

  it("richiede l'autenticazione su ogni rotta", async () => {
    for (const path of ["/", "/api/health", "/api/proposals", "/static/app.js", "/outbox/plaud-rossi-0001/a1-primo-incontro.ics"]) {
      const response = await send(server.port, "GET", path);
      expect(response.status, path).toBe(401);
      expect(response.headers["www-authenticate"]).toBe('Basic realm="Seguito", charset="UTF-8"');
      expect(response.json().error).toMatch(/password/i);
      expectSecurityHeaders(response);
    }
  });

  it("rifiuta credenziali errate o malformate", async () => {
    for (const authorization of [basic("avvocato", "sbagliata"), basic("avvocato", "parola-segreta-lunga"), "Basic !!!", "Bearer parola-segreta"]) {
      expect((await send(server.port, "GET", "/api/health", { headers: { Authorization: authorization } })).status).toBe(401);
    }
  });

  it("accetta la password corretta con qualsiasi nome utente", async () => {
    for (const user of ["avvocato", ""]) {
      const response = await send(server.port, "GET", "/api/health", { headers: { Authorization: basic(user, "parola-segreta") } });
      expect(response.status).toBe(200);
      expect(response.json<unknown>()).toEqual({ ok: true });
    }
    const page = await send(server.port, "GET", "/", { headers: { Authorization: basic("x", "parola-segreta") } });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
  });
});
