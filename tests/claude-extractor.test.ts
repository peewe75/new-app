import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Extraction, Recording, StudioProfile } from "../src/domain/types.js";
import {
  ClaudeExtractor,
  ExtractionError,
  type ClaudeExtractionRequest,
  type ClaudeExtractionResponse,
  type ClaudeMessagesClient,
} from "../src/extract/claude-extractor.js";
import type { ExtractionInput } from "../src/extract/extractor.js";
import { FixtureExtractor } from "../src/extract/fixture-extractor.js";
import { buildSystemPrompt, buildUserContent } from "../src/extract/prompt.js";

const studio: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone",
};

const recording: Recording = {
  id: "plaud:rec-1",
  source: "plaud",
  externalId: "rec-1",
  title: "Chiamata Rossi",
  startedAt: "2026-10-07T07:30:00.000Z",
  durationMs: 60_000,
  segments: [
    { index: 0, startMs: 0, endMs: 3000, speaker: "Speaker 1", text: "Pronto, studio Sapone." },
    { index: 1, startMs: 3000, endMs: 6000, speaker: "Speaker 2", text: "Sono Mario Rossi." },
  ],
  plaudSummary: null,
  fetchedAt: "2026-10-07T08:00:00.000Z",
};

const input: ExtractionInput = { recording, studio, now: new Date("2026-10-07T08:00:00.000Z") };

const extraction: Extraction = {
  conversationType: "telefonata",
  summary: "Il Sig. Rossi chiama lo studio.",
  participants: [
    {
      speakerLabel: "Speaker 2",
      isSpeaker: true,
      name: "Mario Rossi",
      role: "cliente",
      organization: null,
      phone: null,
      email: null,
      evidence: [{ segment: 1, quote: "Sono Mario Rossi" }],
    },
  ],
  actions: [
    {
      type: "attivita",
      description: "Richiamare il Sig. Rossi",
      assignee: null,
      dueDate: null,
      confidence: 0.8,
      evidence: [{ segment: 1, quote: "Sono Mario Rossi" }],
      rationale: "Il cliente ha chiamato lo studio.",
    },
  ],
  doubts: [],
};

/** Client finto che, come l'SDK, analizza il testo con il formato richiesto. */
function fakeClient(reply: { text: string; stop_reason?: string; category?: string | null }) {
  const calls: ClaudeExtractionRequest[] = [];
  const client: ClaudeMessagesClient = {
    beta: {
      messages: {
        async parse(params): Promise<ClaudeExtractionResponse> {
          calls.push(params);
          const stopReason = reply.stop_reason ?? "end_turn";
          return {
            stop_reason: stopReason,
            stop_details: stopReason === "refusal" ? { category: reply.category ?? null } : null,
            parsed_output: params.output_config.format.parse(reply.text),
          };
        },
      },
    },
  };
  return { client, calls };
}

function failingClient(error: unknown): ClaudeMessagesClient {
  return {
    beta: {
      messages: {
        parse: () => Promise.reject(error),
      },
    },
  };
}

async function extractionError(promise: Promise<unknown>): Promise<ExtractionError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExtractionError);
  return error as ExtractionError;
}

describe("ClaudeExtractor", () => {
  test("invia la richiesta prevista e restituisce l'estrazione validata", async () => {
    const { client, calls } = fakeClient({ text: JSON.stringify(extraction) });
    const extractor = new ClaudeExtractor({ model: "claude-opus-5-5", effort: "high", client });

    await expect(extractor.extract(input)).resolves.toEqual(extraction);
    expect(extractor.name).toBe("claude");
    expect(extractor.model).toBe("claude-opus-5-5");

    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(16000);
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.fallbacks).toBe("default");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config.effort).toBe("high");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema).toMatchObject({ type: "object" });
    expect(params.system).toBe(buildSystemPrompt(studio));
    expect(params.messages).toEqual([{ role: "user", content: buildUserContent(input) }]);
    for (const forbidden of ["temperature", "top_p", "top_k", "tool_choice", "tools", "stream"]) {
      expect(params).not.toHaveProperty(forbidden);
    }
  });

  test("rispetta maxTokens e lo sforzo configurati", async () => {
    const { client, calls } = fakeClient({ text: JSON.stringify(extraction) });
    await new ClaudeExtractor({ model: "m", effort: "max", maxTokens: 32000, client }).extract(input);
    expect(calls[0]!.max_tokens).toBe(32000);
    expect(calls[0]!.output_config.effort).toBe("max");
  });

  test("il formato di output non lancia sul JSON troncato", async () => {
    const { client, calls } = fakeClient({ text: JSON.stringify(extraction) });
    await new ClaudeExtractor({ model: "m", effort: "high", client }).extract(input);
    const format = calls[0]!.output_config.format;
    expect(format.parse('{"conversationType": "telef')).toBeNull();
    expect(format.parse(JSON.stringify(extraction))).toEqual(extraction);
  });

  test("rifiuto del modello: errore con la categoria", async () => {
    const { client } = fakeClient({ text: "", stop_reason: "refusal", category: "cyber" });
    const error = await extractionError(new ClaudeExtractor({ model: "m", effort: "high", client }).extract(input));
    expect(error.message).toContain("rifiutato");
    expect(error.message).toContain("cyber");
  });

  test("rifiuto senza categoria", async () => {
    const { client } = fakeClient({ text: "", stop_reason: "refusal", category: null });
    const error = await extractionError(new ClaudeExtractor({ model: "m", effort: "high", client }).extract(input));
    expect(error.message).toContain("non specificata");
  });

  test("output troncato per max_tokens: errore che suggerisce di aumentare il limite", async () => {
    const truncated = JSON.stringify(extraction).slice(0, 40);
    const { client } = fakeClient({ text: truncated, stop_reason: "max_tokens" });
    const extractor = new ClaudeExtractor({ model: "m", effort: "high", maxTokens: 8000, client });
    const error = await extractionError(extractor.extract(input));
    expect(error.message).toContain("troppo lunga");
    expect(error.message).toContain("8000");
    expect(error.message).toContain("SEGUITO_CLAUDE_MAX_TOKENS");
  });

  test("parsed_output nullo: errore di schema con la causa", async () => {
    const { client } = fakeClient({ text: "non è JSON" });
    const error = await extractionError(new ClaudeExtractor({ model: "m", effort: "high", client }).extract(input));
    expect(error.message).toContain("non è conforme allo schema");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("risultato non conforme allo schema: rivalidato e respinto", async () => {
    const client: ClaudeMessagesClient = {
      beta: {
        messages: {
          parse: async () => ({
            stop_reason: "end_turn",
            stop_details: null,
            parsed_output: { ...extraction, conversationType: "lettera" } as unknown as Extraction,
          }),
        },
      },
    };
    const error = await extractionError(new ClaudeExtractor({ model: "m", effort: "high", client }).extract(input));
    expect(error.message).toContain("non è conforme allo schema");
  });

  describe("errori dell'SDK tradotti in italiano, con la causa", () => {
    const headers = new Headers();
    const cases: Array<[string, Error, string]> = [
      ["autenticazione", new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", headers), "non valida o mancante"],
      ["permessi", new Anthropic.PermissionDeniedError(403, undefined, "forbidden", headers), "non è autorizzata"],
      ["modello inesistente", new Anthropic.NotFoundError(404, undefined, "model not found", headers), "SEGUITO_CLAUDE_MODEL"],
      ["limite di richieste", new Anthropic.RateLimitError(429, undefined, "rate limited", headers), "Limite di richieste"],
      ["timeout", new Anthropic.APIConnectionTimeoutError({ message: "timeout" }), "tempo massimo"],
      ["connessione", new Anthropic.APIConnectionError({ message: "offline" }), "Impossibile contattare"],
      ["servizio non disponibile", new Anthropic.InternalServerError(529, undefined, "overloaded", headers), "HTTP 529"],
      ["errore generico", new Anthropic.BadRequestError(400, undefined, "bad request", headers), "HTTP 400"],
      ["errore del client", new Anthropic.AnthropicError("qualcosa"), "client Anthropic"],
      [
        "credenziali assenti",
        new Error("Could not resolve authentication method. Expected one of apiKey, authToken"),
        "non valida o mancante",
      ],
    ];
    for (const [label, sdkError, fragment] of cases) {
      test(label, async () => {
        const extractor = new ClaudeExtractor({ model: "m", effort: "high", client: failingClient(sdkError) });
        const error = await extractionError(extractor.extract(input));
        expect(error.message).toContain(fragment);
        expect(error.cause).toBe(sdkError);
      });
    }

    test("gli errori estranei all'SDK non vengono mascherati", async () => {
      const bug = new TypeError("x is undefined");
      const extractor = new ClaudeExtractor({ model: "m", effort: "high", client: failingClient(bug) });
      await expect(extractor.extract(input)).rejects.toBe(bug);
    });
  });
});

describe("FixtureExtractor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seguito-fixture-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("legge e valida <dir>/<externalId>.extraction.json", async () => {
    await writeFile(join(dir, "rec-1.extraction.json"), JSON.stringify(extraction), "utf8");
    const extractor = new FixtureExtractor({ dir });
    expect(extractor.name).toBe("fixture");
    expect(extractor.model).toBeNull();
    await expect(extractor.extract(input)).resolves.toEqual(extraction);
  });

  test("file mancante: errore che suggerisce ANTHROPIC_API_KEY", async () => {
    const error = await extractionError(new FixtureExtractor({ dir }).extract(input));
    expect(error.message).toContain("rec-1");
    expect(error.message).toContain("ANTHROPIC_API_KEY");
  });

  test("JSON non valido o fuori schema: errore esplicito", async () => {
    await writeFile(join(dir, "rec-1.extraction.json"), "{ non json", "utf8");
    const notJson = await extractionError(new FixtureExtractor({ dir }).extract(input));
    expect(notJson.message).toContain("JSON valido");

    await writeFile(join(dir, "rec-1.extraction.json"), JSON.stringify({ summary: "x" }), "utf8");
    const invalid = await extractionError(new FixtureExtractor({ dir }).extract(input));
    expect(invalid.message).toContain("non è conforme allo schema");
  });

  test("rifiuta identificativi che escono dalla cartella", async () => {
    const outside = { ...input, recording: { ...recording, externalId: "../rec-1" } };
    const error = await extractionError(new FixtureExtractor({ dir }).extract(outside));
    expect(error.message).toContain("non valido");
  });
});
