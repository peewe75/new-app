import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPEECHMATICS_EU_URL, SpeechmaticsTranscriber, toSegments } from "../src/transcribe/speechmatics.js";
import { TranscriptionError } from "../src/transcribe/transcriber.js";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Finto servizio: registra le chiamate e risponde con i gestori indicati, nell'ordine. */
function fakeFetch(handlers: Handler[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(call);
    const handler = handlers.shift();
    if (handler === undefined) throw new Error(`Chiamata inattesa: ${call.method} ${call.url}`);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const word = (content: string, start: number, end: number, speaker = "S1") => ({
  type: "word",
  start_time: start,
  end_time: end,
  alternatives: [{ content, speaker, confidence: 0.98 }],
});

const punct = (content: string, at: number, speaker = "S1", eos = true) => ({
  type: "punctuation",
  start_time: at,
  end_time: at,
  is_eos: eos,
  attaches_to: "previous",
  alternatives: [{ content, speaker, confidence: 1 }],
});

const TRANSCRIPT = {
  format: "2.9",
  job: { id: "job-1", duration: 42.5 },
  results: [
    word("Buongiorno", 0.5, 1.1),
    word("avvocato", 1.2, 1.8),
    punct(",", 1.8, "S1", false),
    word("sono", 1.9, 2.1),
    word("Mario", 2.1, 2.4),
    word("Rossi", 2.4, 2.8),
    punct(".", 2.8),
    word("Buongiorno", 3.5, 4.0, "S2"),
    punct(".", 4.0, "S2"),
    word("Ci", 4.2, 4.3, "S2"),
    word("vediamo", 4.3, 4.7, "S2"),
    word("martedì", 4.7, 5.2, "S2"),
    punct("?", 5.2, "S2"),
    word("Va", 9.0, 9.2, "S2"),
    word("bene", 9.2, 9.5, "S2"),
  ],
};

describe("toSegments", () => {
  it("raggruppa le parole per parlante, attacca la punteggiatura e separa i turni dopo una pausa", () => {
    expect(toSegments(TRANSCRIPT.results)).toEqual([
      { startMs: 500, endMs: 2800, speaker: "Speaker 1", text: "Buongiorno avvocato, sono Mario Rossi." },
      { startMs: 3500, endMs: 5200, speaker: "Speaker 2", text: "Buongiorno. Ci vediamo martedì?" },
      { startMs: 9000, endMs: 9500, speaker: "Speaker 2", text: "Va bene" },
    ]);
  });

  it("la punteggiatura che apre (es. «) va con la parola successiva, anche in un nuovo turno", () => {
    expect(
      toSegments([
        word("Ciao", 0, 0.5),
        punct(".", 0.5),
        { ...punct("«", 3, "S2", false), attaches_to: "next" },
        word("Pronto", 3, 3.4, "S2"),
        { ...punct("»", 3.4, "S2", false), attaches_to: "previous" },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 500, speaker: "Speaker 1", text: "Ciao." },
      { startMs: 3000, endMs: 3400, speaker: "Speaker 2", text: "«Pronto»" },
    ]);
  });

  it("segnala il parlante non riconosciuto e ignora i risultati senza alternative", () => {
    expect(
      toSegments([
        word("Pronto", 0, 0.4, "UU"),
        { type: "word", start_time: 0.5, end_time: 0.6 },
        word("sì", 0.7, 0.9, "UU"),
      ]),
    ).toEqual([{ startMs: 0, endMs: 900, speaker: "Parlante non identificato", text: "Pronto sì" }]);
  });
});

describe("SpeechmaticsTranscriber", () => {
  let dir: string;
  let audioPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seguito-speechmatics-"));
    audioPath = join(dir, "0123456789abcdef0123456789abcdef.audio");
    await writeFile(audioPath, Buffer.from("audio finto"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const input = () => ({ audioPath, contentType: "audio/mp4", language: "it" });

  function transcriber(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof SpeechmaticsTranscriber>[0]> = {}) {
    const waits: number[] = [];
    const t = new SpeechmaticsTranscriber({
      apiKey: "chiave-di-prova",
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
      pollIntervalMs: 10_000,
      ...extra,
    });
    return { t, waits };
  }

  it("invia l'audio alla regione UE, attende il lavoro, legge la trascrizione e la cancella dal servizio", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => json({ id: "job-1" }, 201),
      () => json({ job: { id: "job-1", status: "running" } }),
      () => json({ job: { id: "job-1", status: "done", duration: 42.5 } }),
      () => json(TRANSCRIPT),
      () => new Response(null, { status: 200 }),
    ]);
    const { t, waits } = transcriber(fetchImpl, { vocabulary: ["Esposito", " "] });

    const transcript = await t.transcribe(input());

    expect(transcript.durationMs).toBe(42_500);
    expect(transcript.segments).toHaveLength(3);
    expect(transcript.segments[0]).toMatchObject({ speaker: "Speaker 1", text: "Buongiorno avvocato, sono Mario Rossi." });
    expect(waits).toEqual([10_000]);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${SPEECHMATICS_EU_URL}/jobs`,
      `GET ${SPEECHMATICS_EU_URL}/jobs/job-1?wait=0`,
      `GET ${SPEECHMATICS_EU_URL}/jobs/job-1?wait=0`,
      `GET ${SPEECHMATICS_EU_URL}/jobs/job-1/transcript?format=json-v2`,
      `DELETE ${SPEECHMATICS_EU_URL}/jobs/job-1?force=true`,
    ]);
    for (const call of calls) expect(call.headers.Authorization).toBe("Bearer chiave-di-prova");

    const form = calls[0]?.body as FormData;
    const config = JSON.parse(String(form.get("config")));
    expect(config).toMatchObject({
      type: "transcription",
      transcription_config: { language: "it", model: "enhanced", diarization: "speaker" },
    });
    const vocab = config.transcription_config.additional_vocab.map((v: { content: string }) => v.content);
    expect(vocab).toContain("Cassazione");
    expect(vocab).toContain("Esposito");
    expect(vocab).not.toContain("");
    const file = form.get("data_file") as File;
    expect(file.name).toBe("registrazione-01234567.m4a");
    expect(await file.text()).toBe("audio finto");
  });

  it("chiave errata: errore definitivo, senza lavori da cancellare", async () => {
    const { fetchImpl, calls } = fakeFetch([() => json({ detail: "unauthorized" }, 401)]);
    const err = await transcriber(fetchImpl).t.transcribe(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err).toMatchObject({ retryable: false, message: expect.stringContaining("SPEECHMATICS_API_KEY") });
    expect(calls).toHaveLength(1);
  });

  it("servizio sovraccarico o non raggiungibile: errore transitorio", async () => {
    const busy = fakeFetch([() => json({}, 429)]);
    await expect(transcriber(busy.fetchImpl).t.transcribe(input())).rejects.toMatchObject({ retryable: true });

    const down = fakeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(transcriber(down.fetchImpl).t.transcribe(input())).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("non risponde"),
    });
  });

  it("file rifiutato: errore definitivo e lavoro cancellato", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => json({ id: "job-2" }, 201),
      () => json({ job: { id: "job-2", status: "rejected", errors: [{ message: "unsupported file format" }] } }),
      () => new Response(null, { status: 200 }),
    ]);
    await expect(transcriber(fetchImpl).t.transcribe(input())).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("unsupported file format"),
    });
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("trascrizione troppo lenta: errore transitorio e lavoro cancellato", async () => {
    const running = () => json({ job: { id: "job-3", status: "running" } });
    const { fetchImpl, calls } = fakeFetch([
      () => json({ id: "job-3" }, 201),
      running,
      running,
      running,
      () => new Response(null, { status: 200 }),
    ]);
    await expect(transcriber(fetchImpl, { maxWaitMs: 20_000 }).t.transcribe(input())).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("più del previsto"),
    });
    expect(calls.at(-1)?.url).toBe(`${SPEECHMATICS_EU_URL}/jobs/job-3?force=true`);
  });

  it("un'interruzione di rete durante l'attesa non fa ripetere (e pagare) la trascrizione", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => json({ id: "job-5" }, 201),
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({}, 502),
      () => json({ job: { id: "job-5", status: "done" } }),
      () => json({}, 503),
      () => json(TRANSCRIPT),
      () => new Response(null, { status: 200 }),
    ]);
    const { t, waits } = transcriber(fetchImpl);
    const transcript = await t.transcribe(input());
    expect(transcript.segments).toHaveLength(3);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(waits).toEqual([10_000, 10_000, 5_000]);
  });

  it("all'arresto di Seguito interrompe l'attesa e cancella il lavoro", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = fakeFetch([
      () => json({ id: "job-6" }, 201),
      () => json({ job: { id: "job-6", status: "running" } }),
      () => new Response(null, { status: 200 }),
    ]);
    const t = new SpeechmaticsTranscriber({
      apiKey: "chiave-di-prova",
      fetchImpl,
      pollIntervalMs: 10_000,
      sleep: async () => controller.abort(),
    });
    await expect(t.transcribe({ ...input(), signal: controller.signal })).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("arresto"),
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
  });

  it("la cancellazione non riuscita non fa perdere la trascrizione", async () => {
    const failDelete = () => new Response(null, { status: 500 });
    const { fetchImpl } = fakeFetch([
      () => json({ id: "job-4" }, 201),
      () => json({ job: { id: "job-4", status: "done" } }),
      () => json(TRANSCRIPT),
      failDelete,
      failDelete,
      failDelete,
    ]);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const transcript = await transcriber(fetchImpl).t.transcribe(input());
      expect(transcript.durationMs).toBe(42_500);
    } finally {
      console.error = original;
    }
    expect(String(errors[0])).toContain("job-4");
  });
});
