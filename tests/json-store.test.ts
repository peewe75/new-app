import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Proposal, Recording } from "../src/domain/types.js";
import { JsonFileStore, decodeFileNameToId, encodeIdForFileName } from "../src/store/json-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seguito-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recording(id: string, startedAt = "2026-10-07T07:30:00.000Z"): Recording {
  const [source, externalId] = id.split(":") as ["plaud" | "file", string];
  return {
    id,
    source,
    externalId,
    title: "Chiamata Mario Rossi – decreto ingiuntivo",
    startedAt,
    durationMs: 840_000,
    segments: [{ index: 0, startMs: 0, endMs: 4000, speaker: "Speaker 1", text: "Buongiorno, Studio Sapone." }],
    plaudSummary: null,
    fetchedAt: "2026-10-07T08:00:00.000Z",
  };
}

function proposal(id: string, startedAt: string): Proposal {
  return {
    id,
    recordingId: id,
    createdAt: "2026-10-07T08:00:00.000Z",
    updatedAt: "2026-10-07T08:00:00.000Z",
    status: "da_revisionare",
    recording: { title: `Registrazione ${id}`, startedAt, durationMs: null, source: "plaud" },
    conversationType: "telefonata",
    summary: "Sintesi",
    participants: [],
    actions: [],
    doubts: [],
    warnings: [],
    extractor: { name: "fixture", model: null },
    executions: [],
  };
}

describe("codifica degli id nei nomi di file", () => {
  test("reversibile e senza caratteri pericolosi", () => {
    for (const id of [
      "plaud:abc123",
      "file:Chiamata Rossi.json",
      "../../etc/passwd",
      "plaud:..",
      "x/y\\z",
      "città:è",
      "A:a",
    ]) {
      const encoded = encodeIdForFileName(id);
      expect(encoded).toMatch(/^[a-z0-9_A-F-]+$/);
      expect(encoded).not.toContain(".");
      expect(encoded).not.toContain("/");
      expect(decodeFileNameToId(encoded)).toBe(id);
    }
    expect(encodeIdForFileName("plaud:abc")).toBe("plaud_3Aabc");
  });

  test("distingue id che differiscono solo per maiuscole anche su file system insensibili", () => {
    const upper = encodeIdForFileName("plaud:ABC");
    const lower = encodeIdForFileName("plaud:abc");
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  });

  test("rifiuta nomi non canonici o id non archiviabili", () => {
    expect(decodeFileNameToId("plaud_3aabc")).toBeNull();
    expect(decodeFileNameToId("_61")).toBeNull(); // "a" non va codificata
    expect(decodeFileNameToId("..")).toBeNull();
    expect(decodeFileNameToId("")).toBeNull();
    expect(() => encodeIdForFileName("")).toThrow(/vuoto/);
    expect(() => encodeIdForFileName("x".repeat(300))).toThrow(/troppo lungo/);
  });
});

describe("JsonFileStore", () => {
  test("registrazioni: salvataggio, lettura e permessi riservati", async () => {
    const store = new JsonFileStore(join(dir, "data"));
    const rec = recording("plaud:abc123");
    expect(await store.hasRecording(rec.id)).toBe(false);
    expect(await store.getRecording(rec.id)).toBeNull();
    await store.saveRecording(rec);
    expect(await store.hasRecording(rec.id)).toBe(true);
    expect(await store.getRecording(rec.id)).toEqual(rec);
    expect(await readdir(join(dir, "data", "recordings"))).toEqual(["plaud_3Aabc123.json"]);
    expect((await stat(join(dir, "data"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "data", "recordings"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "data", "recordings", "plaud_3Aabc123.json"))).mode & 0o777).toBe(0o600);
  });

  test("gli id con percorsi non escono dalla cartella", async () => {
    const store = new JsonFileStore(join(dir, "data"));
    const evil = proposal("file:../../evil", "2026-10-01T10:00:00.000Z");
    await store.saveProposal(evil);
    expect(await readdir(dir)).toEqual(["data"]);
    expect(await readdir(join(dir, "data", "proposals"))).toHaveLength(1);
    expect(await store.getProposal("file:../../evil")).toEqual(evil);
    expect(await store.getProposal("../../evil")).toBeNull();
  });

  test("proposte ordinate dalla registrazione più recente; file estranei ignorati", async () => {
    const store = new JsonFileStore(dir);
    await store.saveProposal(proposal("plaud:old", "2026-10-05T09:15:00.000Z"));
    await store.saveProposal(proposal("plaud:new", "2026-10-07T07:30:00.000Z"));
    await store.saveProposal(proposal("plaud:mid", "2026-10-06T14:00:00.000Z"));
    await writeFile(join(dir, "proposals", "note.txt"), "x");
    await writeFile(join(dir, "proposals", "plaud_3Anew.json.123-abc.tmp"), "{");
    expect((await store.listProposals()).map((p) => p.id)).toEqual(["plaud:new", "plaud:mid", "plaud:old"]);
    expect(await new JsonFileStore(join(dir, "vuota")).listProposals()).toEqual([]);
  });

  test("sovrascrittura atomica e convalida in lettura", async () => {
    const store = new JsonFileStore(dir);
    const p = proposal("plaud:x", "2026-10-07T07:30:00.000Z");
    await store.saveProposal(p);
    await store.saveProposal({ ...p, status: "scartata" });
    expect((await store.getProposal("plaud:x"))?.status).toBe("scartata");
    expect((await readdir(join(dir, "proposals"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    await writeFile(join(dir, "proposals", "plaud_3Arotta.json"), JSON.stringify({ id: "plaud:rotta" }));
    await expect(store.getProposal("plaud:rotta")).rejects.toThrow(/non valida/);
    await writeFile(join(dir, "proposals", "plaud_3Ay.json"), "{non json");
    await expect(store.getProposal("plaud:y")).rejects.toThrow(/JSON/);
    await expect(store.saveProposal({ ...p, status: "boh" } as unknown as Proposal)).rejects.toThrow();
  });

  test("un file che contiene un altro id è rifiutato", async () => {
    const store = new JsonFileStore(dir);
    await store.saveRecording(recording("plaud:a"));
    const content = await readFile(join(dir, "recordings", "plaud_3Aa.json"), "utf8");
    await writeFile(join(dir, "recordings", "plaud_3Ab.json"), content);
    await expect(store.getRecording("plaud:b")).rejects.toThrow(/non corrisponde/);
  });

  test("checkpoint", async () => {
    const store = new JsonFileStore(dir);
    expect(await store.getCheckpoint("lastSync:plaud")).toBeNull();
    await Promise.all([
      store.setCheckpoint("lastSync:plaud", "2026-10-07T08:00:00.000Z"),
      store.setCheckpoint("lastSync:file", "2026-10-07T08:01:00.000Z"),
    ]);
    const reopened = new JsonFileStore(dir);
    expect(await reopened.getCheckpoint("lastSync:plaud")).toBe("2026-10-07T08:00:00.000Z");
    expect(await reopened.getCheckpoint("lastSync:file")).toBe("2026-10-07T08:01:00.000Z");
    expect(await reopened.getCheckpoint("toString")).toBeNull();
    expect((await stat(join(dir, "checkpoints.json"))).mode & 0o777).toBe(0o600);
  });
});
