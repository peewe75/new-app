import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Recording } from "../src/domain/types.js";
import { FileSource, parseTranscriptText } from "../src/sources/file-source.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const TZ = "Europe/Rome";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seguito-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function source(path = dir): FileSource {
  return new FileSource({ path, timezone: TZ, now: () => NOW });
}

const cliTranscript = [
  "# title: Telefonata Rossi",
  "# startedAt: 2026-10-07T09:30",
  "",
  "[00:00 - 00:04] Speaker 1: Buongiorno avvocato.",
  "[00:05] Speaker 2: Buongiorno, mi dica.",
  "Continuo sulla riga successiva.",
  "[00:09] Alle ore 10:30 va bene",
  "[1:02:03] Speaker 1: Arrivederci.",
  "[1:02:10] Speaker 2:",
].join("\r\n");

const plaudDetail = {
  id: "plaud-77",
  name: "Riunione Bianchi",
  created_at: "2026-10-05T15:00:00",
  start_at: "2026-10-05T14:00:00",
  duration: 1_800_000,
  serial_number: "PN-1",
  source_list: [
    {
      data_type: "transaction",
      data_content: JSON.stringify([{ start_time: 0, end_time: 3000, speaker: "Speaker 1", content: "Iniziamo." }]),
    },
  ],
  note_list: [{ data_type: "auto_sum_note", data_title: "Seguito", data_content: "Sintesi." }],
};

const savedRecording: Recording = {
  id: "plaud:rec-9",
  source: "plaud",
  externalId: "rec-9",
  title: "Videochiamata Verdi",
  startedAt: "2026-10-06T08:00:00.000Z",
  durationMs: 90_000,
  segments: [{ index: 0, startMs: 0, endMs: 5000, speaker: "Speaker 1", text: "Salve." }],
  plaudSummary: null,
  fetchedAt: "2026-10-06T09:00:00.000Z",
};

describe("FileSource: trascrizione .txt della CLI Plaud", () => {
  test("legge intestazioni, minutaggi, intervalli e righe di continuazione", async () => {
    await writeFile(join(dir, "rossi.txt"), `﻿${cliTranscript}`);
    const recording = await source().fetchRecording("rossi");
    expect(recording).toEqual({
      id: "file:rossi",
      source: "file",
      externalId: "rossi",
      title: "Telefonata Rossi",
      // 09:30 a Roma (ora legale) = 07:30 UTC.
      startedAt: "2026-10-07T07:30:00.000Z",
      durationMs: 3_723_000,
      segments: [
        { index: 0, startMs: 0, endMs: 4000, speaker: "Speaker 1", text: "Buongiorno avvocato." },
        {
          index: 1,
          startMs: 5000,
          endMs: null,
          speaker: "Speaker 2",
          text: "Buongiorno, mi dica.\nContinuo sulla riga successiva.",
        },
        { index: 2, startMs: 9000, endMs: null, speaker: "Parlante", text: "Alle ore 10:30 va bene" },
        { index: 3, startMs: 3_723_000, endMs: null, speaker: "Speaker 1", text: "Arrivederci." },
      ],
      plaudSummary: null,
      fetchedAt: NOW.toISOString(),
    });
  });

  test("senza intestazioni usa il nome del file e la data di modifica", async () => {
    const path = join(dir, "chiamata-verdi.txt");
    await writeFile(path, "[00:01] Speaker 1: Pronto?\n");
    const mtime = new Date("2026-10-04T16:20:00.000Z");
    await utimes(path, mtime, mtime);
    const [ref] = await source().listRecent();
    expect(ref).toEqual({
      externalId: "chiamata-verdi",
      title: "chiamata-verdi",
      startedAt: mtime.toISOString(),
      durationMs: 1000,
      ready: true,
    });
  });

  test("accetta date con fuso esplicito e rifiuta testo prima del primo intervento", () => {
    const parsed = parseTranscriptText("# startedAt: 2026-10-07T09:30:00+02:00\n[00:00] A: ok", TZ);
    expect(parsed.startedAt).toBe("2026-10-07T07:30:00.000Z");
    expect(() => parseTranscriptText("Trascrizione\n[00:00] A: ok", TZ)).toThrow(/riga 1/);
    expect(() => parseTranscriptText("# startedAt: domani\n[00:00] A: ok", TZ)).toThrow(/data di inizio non valida/);
  });

  test("file senza interventi -> errore con il nome del file", async () => {
    await writeFile(join(dir, "vuoto.txt"), "# title: Vuoto\n");
    await expect(source().listRecent()).rejects.toThrow(/vuoto\.txt/);
  });
});

describe("FileSource: JSON", () => {
  test("dettaglio Plaud con contenuto inline", async () => {
    await writeFile(join(dir, "bianchi.json"), JSON.stringify(plaudDetail));
    const recording = await source().fetchRecording("plaud-77");
    expect(recording).toMatchObject({
      id: "file:plaud-77",
      source: "file",
      externalId: "plaud-77",
      title: "Riunione Bianchi",
      startedAt: "2026-10-05T14:00:00.000Z",
      durationMs: 1_800_000,
      plaudSummary: "Sintesi.",
      fetchedAt: NOW.toISOString(),
    });
    expect(recording.segments).toEqual([
      { index: 0, startMs: 0, endMs: 3000, speaker: "Speaker 1", text: "Iniziamo." },
    ]);
  });

  test("dettaglio Plaud con data_link -> errore (solo contenuti inline)", async () => {
    const withLink = {
      ...plaudDetail,
      source_list: [{ data_type: "transaction", data_link: "https://cdn.plaud.example/t.json" }],
    };
    await writeFile(join(dir, "remoto.json"), JSON.stringify(withLink));
    const [ref] = await source().listRecent();
    expect(ref?.ready).toBe(true);
    await expect(source().fetchRecording("plaud-77")).rejects.toThrow(/data_link/);
  });

  test("dettaglio Plaud senza trascrizione -> errore chiaro", async () => {
    await writeFile(join(dir, "incompleto.json"), JSON.stringify({ ...plaudDetail, source_list: [] }));
    await expect(source().fetchRecording("plaud-77")).rejects.toThrow(/non contiene la trascrizione/);
  });

  test("Recording validata e ricondotta alla fonte file", async () => {
    await writeFile(join(dir, "verdi.json"), JSON.stringify(savedRecording));
    const recording = await source().fetchRecording("rec-9");
    expect(recording).toEqual({
      ...savedRecording,
      id: "file:rec-9",
      source: "file",
      fetchedAt: NOW.toISOString(),
    });
  });

  test("Recording non valida o JSON malformato -> errore", async () => {
    await writeFile(join(dir, "rotto.json"), JSON.stringify({ ...savedRecording, segments: [{ index: "zero" }] }));
    await expect(source().listRecent()).rejects.toThrow(/rotto\.json.*non è una registrazione valida/);
    await writeFile(join(dir, "rotto.json"), "{ incompleto");
    await expect(source().listRecent()).rejects.toThrow(/JSON valido/);
  });
});

describe("FileSource: elenco e ricerca", () => {
  beforeEach(async () => {
    await writeFile(join(dir, "rossi.txt"), cliTranscript);
    await writeFile(join(dir, "bianchi.json"), JSON.stringify(plaudDetail));
    await writeFile(join(dir, "verdi.json"), JSON.stringify(savedRecording));
    await writeFile(join(dir, "appunti.md"), "# non è una trascrizione");
    await writeFile(join(dir, "impostazioni.json"), JSON.stringify({ tema: "scuro" }));
  });

  test("elenca i formati supportati dal più recente, ignorando gli altri file", async () => {
    const refs = await source().listRecent();
    expect(refs.map((r) => r.externalId)).toEqual(["rossi", "rec-9", "plaud-77"]);
    expect(refs.every((r) => r.ready)).toBe(true);
  });

  test("applica since e limit", async () => {
    const refs = await source().listRecent({ since: new Date("2026-10-06T00:00:00Z"), limit: 1 });
    expect(refs.map((r) => r.externalId)).toEqual(["rossi"]);
    const recent = await source().listRecent({ since: new Date("2026-10-06T00:00:00Z") });
    expect(recent.map((r) => r.externalId)).toEqual(["rossi", "rec-9"]);
  });

  test("registrazione inesistente -> errore in italiano", async () => {
    await expect(source().fetchRecording("sconosciuta")).rejects.toThrow(/Registrazione "sconosciuta" non trovata/);
  });

  test("accetta anche il percorso di un singolo file", async () => {
    const refs = await source(join(dir, "verdi.json")).listRecent();
    expect(refs.map((r) => r.externalId)).toEqual(["rec-9"]);
    await expect(source(join(dir, "appunti.md")).listRecent()).rejects.toThrow(/Formato non supportato/);
    await expect(source(join(dir, "manca")).listRecent()).rejects.toThrow(/non trovato/);
  });
});
