import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CaseManagementDataSchema,
  ExtractionSchema,
  RecordingSchema,
  type Evidence,
  type Extraction,
  type Recording,
} from "../src/domain/types.js";
import { resolveEvidence } from "../src/extract/postprocess.js";
import { FileSource } from "../src/sources/file-source.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const PLAUD_DIR = join(FIXTURES, "plaud");
const EXTRACTIONS_DIR = join(FIXTURES, "extractions");
const EXTRACTION_SUFFIX = ".extraction.json";

async function jsonFiles(dir: string, suffix = ".json"): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(suffix)).sort();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Tutte le evidenze di un'analisi, con la provenienza per i messaggi di errore. */
function allEvidence(extraction: Extraction): Array<{ where: string; evidence: Evidence[] }> {
  return [
    ...extraction.participants.map((p, i) => ({ where: `partecipante ${i} (${p.name ?? "senza nome"})`, evidence: p.evidence })),
    ...extraction.actions.map((a, i) => ({ where: `azione a${i + 1} (${a.type})`, evidence: a.evidence })),
    ...extraction.doubts.map((d, i) => ({ where: `dubbio ${i}`, evidence: d.evidence })),
  ];
}

describe("fixture della demo", () => {
  const recordings = new Map<string, Recording>();
  const extractions = new Map<string, Extraction>();

  beforeAll(async () => {
    const source = new FileSource({ path: PLAUD_DIR, now: () => new Date("2026-10-07T08:00:00Z") });
    for (const ref of await source.listRecent({ limit: 1000 })) {
      recordings.set(ref.externalId, await source.fetchRecording(ref.externalId));
    }
    for (const name of await jsonFiles(EXTRACTIONS_DIR, EXTRACTION_SUFFIX)) {
      const parsed = ExtractionSchema.parse(await readJson(join(EXTRACTIONS_DIR, name)));
      extractions.set(name.slice(0, -EXTRACTION_SUFFIX.length), parsed);
    }
  });

  it("ogni file Plaud diventa una registrazione valida tramite FileSource", async () => {
    const files = await jsonFiles(PLAUD_DIR);
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect([...recordings.keys()].sort()).toEqual(files.map((f) => basename(f, ".json")).sort());
    for (const [externalId, recording] of recordings) {
      expect(RecordingSchema.parse(recording)).toEqual(recording);
      expect(recording.id).toBe(`file:${externalId}`);
      expect(recording.source).toBe("file");
      expect(recording.segments.length).toBeGreaterThanOrEqual(28);
      expect(recording.segments.map((s) => s.index)).toEqual(recording.segments.map((_, i) => i));
      expect(recording.plaudSummary).toBeTruthy();
      expect(Number.isNaN(Date.parse(recording.startedAt))).toBe(false);
    }
  });

  it("ogni analisi di esempio rispetta lo schema e ha la sua registrazione, e viceversa", () => {
    expect(extractions.size).toBe(recordings.size);
    for (const id of recordings.keys()) expect(extractions.has(id), `analisi mancante per ${id}`).toBe(true);
    for (const id of extractions.keys()) expect(recordings.has(id), `registrazione mancante per ${id}`).toBe(true);
  });

  it("tutte le citazioni delle analisi si ritrovano nella trascrizione", () => {
    let total = 0;
    for (const [id, extraction] of extractions) {
      const recording = recordings.get(id);
      expect(recording).toBeDefined();
      for (const { where, evidence } of allEvidence(extraction)) {
        for (const resolved of resolveEvidence(evidence, recording?.segments ?? [])) {
          total++;
          expect(resolved.verified, `${id}, ${where}: «${resolved.quote}» (segmento ${resolved.segment})`).toBe(true);
        }
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it("le azioni hanno sempre almeno una citazione", () => {
    for (const [id, extraction] of extractions) {
      for (const [i, action] of extraction.actions.entries()) {
        expect(action.evidence.length, `${id}, azione a${i + 1}`).toBeGreaterThan(0);
      }
    }
  });

  it("il gestionale di esempio è valido e ha identificativi univoci", async () => {
    const data = CaseManagementDataSchema.parse(await readJson(join(FIXTURES, "gestionale.json")));
    const clientIds = data.clients.map((c) => c.id);
    const matterIds = data.matters.map((m) => m.id);
    const noteIds = data.matters.flatMap((m) => m.notes.map((n) => n.id));
    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(new Set(matterIds).size).toBe(matterIds.length);
    expect(new Set(noteIds).size).toBe(noteIds.length);
    expect(new Set(data.matters.map((m) => m.number)).size).toBe(data.matters.length);
    for (const matter of data.matters) expect(clientIds).toContain(matter.clientId);
    for (const client of data.clients) {
      if (client.email !== null) expect(client.email).toMatch(/@example\.com$/);
    }
  });
});
