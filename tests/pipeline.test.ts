import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveProposal, ProposalStateError } from "../src/actions/run.js";
import {
  CaseManagementDataSchema,
  type ActionType,
  type CaseManagementData,
  type Proposal,
  type ProposedAction,
  type Recording,
  type RecordingRef,
  type StudioProfile,
} from "../src/domain/types.js";
import { JsonCaseManagement } from "../src/enrich/json-case-management.js";
import { ExtractionError } from "../src/extract/claude-extractor.js";
import type { ExtractionInput, Extractor } from "../src/extract/extractor.js";
import { FixtureExtractor } from "../src/extract/fixture-extractor.js";
import {
  approveStoredProposal,
  discardStoredProposal,
  processRecording,
  syncSource,
  type PipelineDeps,
} from "../src/pipeline.js";
import { FileSource } from "../src/sources/file-source.js";
import { PlaudAuthError, PlaudNotReadyError } from "../src/sources/plaud-parse.js";
import { recordingId, type RecordingSource } from "../src/sources/source.js";
import { JsonFileStore } from "../src/store/json-store.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const ROSSI = "file:demo-rossi-decreto-ingiuntivo";
const BIANCHI = "file:demo-avv-bianchi-transazione";
const VERDI = "file:demo-verdi-sovraindebitamento";
const DEMO_DELAY_MS = 30 * 60 * 1000;

const studio: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone\nStudio Legale Sapone",
};

/** Estrattore che conta le chiamate e può fallire per alcune registrazioni. */
class CountingExtractor implements Extractor {
  readonly name = "prova";
  readonly model = null;
  readonly calls: string[] = [];
  private readonly inner = new FixtureExtractor({ dir: join(FIXTURES, "extractions") });

  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}

  async extract(input: ExtractionInput) {
    this.calls.push(input.recording.externalId);
    if (this.failing.has(input.recording.externalId)) {
      throw new ExtractionError("Analisi non riuscita: il servizio di analisi non risponde.");
    }
    return this.inner.extract(input);
  }
}

interface Env {
  dir: string;
  dataDir: string;
  outboxDir: string;
  caseManagementFile: string;
  deps: PipelineDeps;
}

let env: Env;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "seguito-pipeline-"));
  const caseManagementFile = join(dir, "gestionale.json");
  await copyFile(join(FIXTURES, "gestionale.json"), caseManagementFile);
  const dataDir = join(dir, "data");
  env = {
    dir,
    dataDir,
    outboxDir: join(dir, "outbox"),
    caseManagementFile,
    deps: {
      store: new JsonFileStore(dataDir),
      extractor: new FixtureExtractor({ dir: join(FIXTURES, "extractions") }),
      caseManagement: new JsonCaseManagement(caseManagementFile, {
        timeZone: studio.timezone,
        now: () => new Date("2026-10-07T08:30:00Z"),
      }),
      studio,
    },
  };
});

afterEach(async () => {
  await rm(env.dir, { recursive: true, force: true });
});

async function loadFixtureRecordings(): Promise<Recording[]> {
  const source = new FileSource({ path: join(FIXTURES, "plaud"), now: () => new Date("2026-10-07T08:00:00Z") });
  const refs = await source.listRecent({ limit: 100 });
  return Promise.all(refs.map((ref) => source.fetchRecording(ref.externalId)));
}

/** Come la demo: analisi 30 minuti dopo l'inizio della chiamata. */
async function processFixtures(): Promise<Map<string, Proposal>> {
  const proposals = new Map<string, Proposal>();
  for (const recording of await loadFixtureRecordings()) {
    const now = new Date(Date.parse(recording.startedAt) + DEMO_DELAY_MS);
    const { proposal, created } = await processRecording(recording, env.deps, { now });
    expect(created).toBe(true);
    proposals.set(proposal.id, proposal);
  }
  return proposals;
}

function get<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Elemento mancante: ${key}`);
  return value;
}

function actionOf(proposal: Proposal, type: ActionType): ProposedAction {
  const action = proposal.actions.find((a) => a.payload.type === type);
  if (action === undefined) throw new Error(`Azione ${type} mancante in ${proposal.id}`);
  return action;
}

function warningCodes(action: ProposedAction): string[] {
  return action.warnings.map((w) => w.code);
}

async function readCaseManagement(): Promise<CaseManagementData> {
  return CaseManagementDataSchema.parse(JSON.parse(await readFile(env.caseManagementFile, "utf8")));
}

async function readArtifact(proposal: Proposal, actionId: string, kind: "ics" | "eml"): Promise<string> {
  const execution = proposal.executions.find((e) => e.actionId === actionId);
  const artifact = execution?.artifacts.find((a) => a.kind === kind);
  if (artifact?.path == null) throw new Error(`File ${kind} mancante per ${actionId}`);
  expect(artifact.path.startsWith("/")).toBe(false);
  return readFile(join(env.outboxDir, ...artifact.path.split("/")), "utf8");
}

describe("processRecording con le fixture", () => {
  it("costruisce la proposta di Rossi con le azioni preselezionate e l'email completata dal gestionale", async () => {
    const rossi = get(await processFixtures(), ROSSI);
    expect(rossi.status).toBe("da_revisionare");
    expect(rossi.warnings.map((w) => w.code)).not.toContain("COLLEGA_ART38");
    for (const type of ["appuntamento", "incarico", "accordo_economico", "email"] as const) {
      expect(actionOf(rossi, type).preselected, type).toBe(true);
    }
    const email = actionOf(rossi, "email");
    expect(email.payload).toMatchObject({ type: "email", recipientEmail: "mario.rossi@example.com" });
    const deadline = actionOf(rossi, "scadenza");
    expect(warningCodes(deadline)).toContain("TERMINE_DA_VERIFICARE");
    expect(deadline.preselected).toBe(false);
    expect(rossi.participants.find((p) => p.role === "cliente")?.clientMatch?.clientId).toBe("C-0001");
    expect(rossi.actions.at(-1)).toMatchObject({
      origin: "sistema",
      payload: { type: "invio_trascrizione", to: studio.studioEmail },
      preselected: true,
    });
  });

  it("blocca la proposta della telefonata con l'Avv. Bianchi (collega) senza preselezioni", async () => {
    const bianchi = get(await processFixtures(), BIANCHI);
    expect(bianchi.warnings).toContainEqual(expect.objectContaining({ code: "COLLEGA_ART38", severity: "bloccante" }));
    expect(bianchi.actions.length).toBeGreaterThan(1);
    expect(bianchi.actions.every((a) => !a.preselected)).toBe(true);
    expect(bianchi.participants.find((p) => p.role === "collega_avvocato")?.clientMatch ?? null).toBeNull();
  });

  it("segnala che Verdi non è nel gestionale", async () => {
    const verdi = get(await processFixtures(), VERDI);
    expect(warningCodes(actionOf(verdi, "incarico"))).toContain("CLIENTE_NON_TROVATO");
    expect(actionOf(verdi, "incarico").preselected).toBe(true);
    expect(actionOf(verdi, "appuntamento").payload).toMatchObject({ status: "da_fissare", start: null });
  });

  it("archivia registrazioni e proposte e non rianalizza una registrazione già elaborata", async () => {
    const extractor = new CountingExtractor();
    env.deps.extractor = extractor;
    const [recording] = await loadFixtureRecordings();
    if (recording === undefined) throw new Error("Nessuna fixture");
    const first = await processRecording(recording, env.deps, { now: new Date("2026-10-07T08:00:00Z") });
    const second = await processRecording(recording, env.deps, { now: new Date("2026-10-08T08:00:00Z") });
    expect(first.created).toBe(true);
    expect(second).toEqual({ proposal: first.proposal, created: false });
    expect(extractor.calls).toHaveLength(1);
    expect(await env.deps.store.getRecording(recording.id)).toEqual(recording);
    expect(await env.deps.store.getProposal(recording.id)).toEqual(first.proposal);
    expect(first.proposal.extractor).toEqual({ name: "prova", model: null });

    const forced = await processRecording(recording, env.deps, { now: new Date("2026-10-08T08:00:00Z"), force: true });
    expect(forced.created).toBe(true);
    expect(forced.proposal.createdAt).toBe("2026-10-08T08:00:00.000Z");
    expect(extractor.calls).toHaveLength(2);
  });
});

describe("approvazione end-to-end", () => {
  it("esegue le azioni preselezionate di Rossi: calendario, bozze email e gestionale", async () => {
    const rossi = get(await processFixtures(), ROSSI);
    const before = await readCaseManagement();
    const selected = rossi.actions.filter((a) => a.preselected).map((a) => a.id);
    const now = new Date("2026-10-07T09:00:00Z");

    const approved = await approveStoredProposal(
      ROSSI,
      { actionIds: selected },
      { store: env.deps.store, caseManagement: env.deps.caseManagement, studio, outboxDir: env.outboxDir },
      now,
    );

    expect(approved.status).toBe("eseguita");
    expect(approved.executions.map((e) => e.actionId).sort()).toEqual([...selected].sort());
    for (const execution of approved.executions) expect(execution.status, execution.message).toBe("ok");
    expect(await env.deps.store.getProposal(ROSSI)).toEqual(approved);

    const ics = await readArtifact(approved, actionOf(approved, "appuntamento").id, "ics");
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("DTSTART:20261015T080000Z\r\n");
    expect(ics).toContain("END:VEVENT\r\n");

    const eml = await readArtifact(approved, actionOf(approved, "email").id, "eml");
    expect(eml).toContain("X-Unsent: 1\r\n");
    expect(eml).toMatch(/^To: .*mario\.rossi@example\.com/m);
    expect(eml).toMatch(/^From: .*avvocato@studio\.example/m);

    const transcript = await readArtifact(approved, actionOf(approved, "invio_trascrizione").id, "eml");
    expect(transcript).toMatch(/^To: .*segreteria@studio\.example/m);
    expect(transcript).toContain("trascrizione.txt");

    const after = await readCaseManagement();
    expect(after.clients).toHaveLength(before.clients.length);
    const newMatters = after.matters.filter((m) => !before.matters.some((b) => b.id === m.id));
    expect(newMatters).toHaveLength(1);
    const matter = newMatters[0];
    expect(matter).toMatchObject({ clientId: "C-0001", status: "aperta" });
    expect(matter?.number).toMatch(/^2026\/\d{3}$/);
    const notes = matter?.notes ?? [];
    expect(notes.map((n) => n.kind)).toEqual(expect.arrayContaining(["incarico", "accordo_economico"]));
    expect(notes.every((n) => n.sourceRecordingId === ROSSI && n.author === "Seguito")).toBe(true);

    // Più tardi, verificato il termine sulla relata, l'avvocato approva anche la scadenza.
    const deadlineId = actionOf(approved, "scadenza").id;
    const stored = { store: env.deps.store, caseManagement: env.deps.caseManagement, studio, outboxDir: env.outboxDir };
    const later = await approveStoredProposal(ROSSI, { actionIds: [...selected, deadlineId] }, stored, now);
    expect(later.status).toBe("eseguita");
    const rerun = later.executions.slice(approved.executions.length);
    expect(rerun.filter((e) => e.status === "saltata").map((e) => e.actionId).sort()).toEqual([...selected].sort());
    expect(rerun.find((e) => e.actionId === deadlineId)?.status).toBe("ok");
    const deadlineIcs = await readArtifact(later, deadlineId, "ics");
    expect(deadlineIcs).toContain("DTSTART;VALUE=DATE:20261111\r\n");
    expect((await readCaseManagement()).matters).toHaveLength(after.matters.length);

    const again = await approveStoredProposal(ROSSI, { actionIds: [deadlineId] }, stored, now).catch(
      (err: unknown) => err,
    );
    expect(again).toBeInstanceOf(ProposalStateError);
  });

  it("approvando l'incarico di Verdi crea il nuovo cliente nel gestionale", async () => {
    const verdi = get(await processFixtures(), VERDI);
    const recording = await env.deps.store.getRecording(VERDI);
    if (recording === null) throw new Error("Registrazione di Verdi non archiviata");
    const before = await readCaseManagement();

    const approved = await approveProposal({
      proposal: verdi,
      request: { actionIds: [actionOf(verdi, "incarico").id] },
      recording,
      studio,
      outboxDir: env.outboxDir,
      caseManagement: env.deps.caseManagement,
      now: new Date("2026-10-07T09:00:00Z"),
    });

    expect(approved.status).toBe("eseguita");
    const after = await readCaseManagement();
    const created = after.clients.filter((c) => !before.clients.some((b) => b.id === c.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ displayName: "Paolo Verdi", firstName: "Paolo", lastName: "Verdi" });
    const matter = after.matters.find((m) => m.clientId === created[0]?.id);
    expect(matter?.status).toBe("in_valutazione");
    expect(matter?.notes.map((n) => n.kind)).toEqual(["incarico"]);
  });

  it("scarta una proposta archiviata e non consente di rigenerarla dopo l'esecuzione", async () => {
    await processFixtures();
    const discarded = await discardStoredProposal(BIANCHI, { store: env.deps.store }, new Date("2026-10-07T10:00:00Z"));
    expect(discarded.status).toBe("scartata");
    expect((await env.deps.store.getProposal(BIANCHI))?.status).toBe("scartata");
    await expect(discardStoredProposal("file:inesistente", { store: env.deps.store })).rejects.toThrow(
      "Proposta non trovata",
    );

    const verdi = get(await env.deps.store.listProposals().then((ps) => new Map(ps.map((p) => [p.id, p]))), VERDI);
    await approveStoredProposal(
      VERDI,
      { actionIds: [actionOf(verdi, "invio_trascrizione").id] },
      { store: env.deps.store, caseManagement: env.deps.caseManagement, studio, outboxDir: env.outboxDir },
    );
    const recording = await env.deps.store.getRecording(VERDI);
    if (recording === null) throw new Error("Registrazione di Verdi non archiviata");
    await expect(processRecording(recording, env.deps, { force: true })).rejects.toBeInstanceOf(ProposalStateError);
  });
});

describe("syncSource", () => {
  /** Fonte finta "plaud" costruita sulle fixture, con esiti programmabili per registrazione. */
  class FakeSource implements RecordingSource {
    readonly name = "plaud" as const;
    readonly fetched: string[] = [];
    readonly notReady = new Set<string>();
    readonly broken = new Set<string>();
    authExpired = false;

    constructor(private readonly recordings: Recording[]) {}

    async listRecent(opts: { since?: Date; limit?: number } = {}): Promise<RecordingRef[]> {
      if (this.authExpired) throw new PlaudAuthError();
      return this.recordings
        .filter((r) => opts.since === undefined || Date.parse(r.startedAt) >= opts.since.getTime())
        .map((r) => ({
          externalId: r.externalId,
          title: r.title,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          ready: r.durationMs !== null,
        }))
        .slice(0, opts.limit ?? 50);
    }

    async fetchRecording(externalId: string): Promise<Recording> {
      this.fetched.push(externalId);
      if (this.authExpired) throw new PlaudAuthError();
      if (this.notReady.has(externalId)) throw new PlaudNotReadyError();
      if (this.broken.has(externalId)) throw new Error("Plaud non risponde: riprovare più tardi.");
      const recording = this.recordings.find((r) => r.externalId === externalId);
      if (recording === undefined) throw new Error(`Registrazione ${externalId} inesistente.`);
      return recording;
    }
  }

  function asPlaud(recording: Recording, externalId: string, overrides: Partial<Recording> = {}): Recording {
    return { ...recording, ...overrides, source: "plaud", externalId, id: recordingId("plaud", externalId) };
  }

  async function plaudRecordings(): Promise<Recording[]> {
    const fixtures = new Map((await loadFixtureRecordings()).map((r) => [r.externalId, r]));
    const rossi = get(fixtures, "demo-rossi-decreto-ingiuntivo");
    return [
      rossi,
      get(fixtures, "demo-avv-bianchi-transazione"),
      get(fixtures, "demo-verdi-sovraindebitamento"),
    ].map((r) => asPlaud(r, r.externalId)).concat([
      asPlaud(rossi, "in-elaborazione", { title: "Registrazione in elaborazione", durationMs: null }),
      asPlaud(rossi, "analisi-fallita", { title: "Analisi fallita" }),
    ]);
  }

  it("elabora le nuove, rimanda quelle non pronte, raccoglie gli errori e non ripete il lavoro", async () => {
    const source = new FakeSource(await plaudRecordings());
    source.notReady.add("demo-verdi-sovraindebitamento");
    source.broken.add("demo-avv-bianchi-transazione");
    const extractor = new CountingExtractor(new Set(["analisi-fallita"]));
    env.deps.extractor = extractor;
    const logs: string[] = [];
    const runAt = new Date("2026-10-07T12:00:00Z");

    const first = await syncSource(source, env.deps, { now: () => runAt, log: (m) => logs.push(m) });

    expect(first).toMatchObject({ processed: 1, skipped: 0, notReady: 2 });
    expect(first.errors).toHaveLength(2);
    expect(first.errors.find((e) => e.includes("Telefonata Avv. Bianchi"))).toContain("Plaud non risponde");
    expect(first.errors.find((e) => e.includes("Analisi fallita"))).toContain("il servizio di analisi non risponde");
    expect(source.fetched).not.toContain("in-elaborazione");
    expect(await env.deps.store.getProposal("plaud:demo-rossi-decreto-ingiuntivo")).not.toBeNull();
    expect(await env.deps.store.getProposal("plaud:analisi-fallita")).toBeNull();
    expect(await env.deps.store.getCheckpoint("lastSync:plaud")).toBe(runAt.toISOString());
    expect(logs.some((l) => l.includes("Chiamata Mario Rossi"))).toBe(true);

    source.notReady.clear();
    source.broken.clear();
    const secondRunAt = new Date("2026-10-07T12:05:00Z");
    const second = await syncSource(source, env.deps, { now: () => secondRunAt });
    expect(second).toEqual({ processed: 2, skipped: 1, notReady: 1, errors: [expect.stringContaining("Analisi fallita")] });
    expect(await env.deps.store.getCheckpoint("lastSync:plaud")).toBe(secondRunAt.toISOString());

    const third = await syncSource(source, env.deps, { now: () => secondRunAt });
    expect(third.processed).toBe(0);
    expect(third.skipped).toBe(3);
    expect(extractor.calls.filter((id) => id === "demo-rossi-decreto-ingiuntivo")).toHaveLength(1);
    const bianchi = await env.deps.store.getProposal("plaud:demo-avv-bianchi-transazione");
    expect(bianchi?.warnings.map((w) => w.code)).toContain("COLLEGA_ART38");
  });

  it("passa since e limit alla fonte", async () => {
    const source = new FakeSource(await plaudRecordings());
    const result = await syncSource(source, env.deps, { since: new Date("2026-10-07T00:00:00Z"), limit: 10 });
    // Restano Rossi, la registrazione non pronta e quella senza analisi di esempio.
    expect(result).toMatchObject({ processed: 1, skipped: 0, notReady: 1 });
    expect(result.errors).toEqual([expect.stringContaining("Nessuna analisi di esempio")]);
    expect([...source.fetched].sort()).toEqual(["analisi-fallita", "demo-rossi-decreto-ingiuntivo"]);

    const limited = await syncSource(new FakeSource(await plaudRecordings()), env.deps, { limit: 1 });
    expect(limited).toEqual({ processed: 0, skipped: 1, notReady: 0, errors: [] });
  });

  it("si ferma con le credenziali Plaud scadute, senza aggiornare il checkpoint", async () => {
    const source = new FakeSource(await plaudRecordings());
    source.authExpired = true;
    await expect(syncSource(source, env.deps)).rejects.toBeInstanceOf(PlaudAuthError);
    expect(await env.deps.store.getCheckpoint("lastSync:plaud")).toBeNull();
  });
});
