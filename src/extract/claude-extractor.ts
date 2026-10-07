/**
 * Estrattore basato su Claude (structured outputs): una sola richiesta per
 * registrazione, con fallback lato server in caso di rifiuto del modello.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AppConfig } from "../config.js";
import { ExtractionSchema, type Extraction } from "../domain/types.js";
import type { ExtractionInput, Extractor } from "./extractor.js";
import { buildSystemPrompt, buildUserContent } from "./prompt.js";

export type ClaudeEffort = AppConfig["claude"]["effort"];

/** Formato di output che restituisce null (invece di lanciare) se il JSON non è valido. */
export type ExtractionOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat & {
  parse(content: string): Extraction | null;
};

export type ClaudeExtractionRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming & {
  output_config: { effort: ClaudeEffort; format: ExtractionOutputFormat };
};

export interface ClaudeExtractionResponse {
  stop_reason: string | null;
  stop_details: { category: string | null } | null;
  parsed_output: Extraction | null;
}

/** Sottoinsieme del client Anthropic usato qui: consente di iniettare un client finto nei test. */
export interface ClaudeMessagesClient {
  beta: {
    messages: {
      parse(params: ClaudeExtractionRequest): PromiseLike<ClaudeExtractionResponse>;
    };
  };
}

export interface ClaudeExtractorOptions {
  model: string;
  effort: ClaudeEffort;
  /** Default 16000. */
  maxTokens?: number;
  client?: ClaudeMessagesClient;
}

/** Errore di analisi con messaggio in italiano, da mostrare all'avvocato. */
export class ExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

const DEFAULT_MAX_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ClaudeExtractor implements Extractor {
  readonly name = "claude";
  readonly model: string;
  private readonly effort: ClaudeEffort;
  private readonly maxTokens: number;
  private readonly client: ClaudeMessagesClient;

  constructor(opts: ClaudeExtractorOptions) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.client = opts.client ?? new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
  }

  async extract(input: ExtractionInput): Promise<Extraction> {
    const output = tolerantExtractionFormat();
    let response: ClaudeExtractionResponse;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: this.maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort, format: output.format },
        system: buildSystemPrompt(input.studio),
        messages: [{ role: "user", content: buildUserContent(input) }],
      });
    } catch (error) {
      throw toExtractionError(error);
    }
    return this.readExtraction(response, output.lastParseError());
  }

  private readExtraction(response: ClaudeExtractionResponse, parseError: unknown): Extraction {
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "non specificata";
      throw new ExtractionError(
        `Il modello ha rifiutato di analizzare la trascrizione (categoria: ${category}). ` +
          "Verificare il contenuto della registrazione o procedere manualmente.",
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new ExtractionError(
        `Analisi interrotta: la trascrizione è troppo lunga e il risultato ha superato il limite di ${this.maxTokens} token in uscita. ` +
          "Aumentare il limite (SEGUITO_CLAUDE_MAX_TOKENS) e riprovare.",
      );
    }
    if (response.parsed_output === null) {
      throw new ExtractionError("La risposta del modello non è conforme allo schema atteso: riprovare l'analisi.", {
        cause: parseError ?? undefined,
      });
    }
    const checked = ExtractionSchema.safeParse(response.parsed_output);
    if (!checked.success) {
      throw new ExtractionError("La risposta del modello non è conforme allo schema atteso: riprovare l'analisi.", {
        cause: checked.error,
      });
    }
    return checked.data;
  }
}

/**
 * L'SDK analizza il testo prima che si possa leggere stop_reason: con l'output
 * troncato o un rifiuto a metà lancerebbe un errore generico. Qui il parse
 * restituisce null e conserva l'errore, così i casi sono distinti.
 */
function tolerantExtractionFormat(): { format: ExtractionOutputFormat; lastParseError: () => unknown } {
  const strict = betaZodOutputFormat(ExtractionSchema);
  let lastError: unknown = null;
  const format: ExtractionOutputFormat = {
    type: strict.type,
    schema: strict.schema,
    parse(content: string): Extraction | null {
      try {
        return strict.parse(content);
      } catch (error) {
        lastError = error;
        return null;
      }
    },
  };
  return { format, lastParseError: () => lastError };
}

/** Traduce gli errori dell'SDK in messaggi italiani, conservando la causa. */
function toExtractionError(error: unknown): Error {
  if (error instanceof ExtractionError) return error;
  const fail = (message: string): ExtractionError => new ExtractionError(message, { cause: error });
  if (error instanceof Anthropic.AuthenticationError) {
    return fail("Chiave API di Anthropic non valida o mancante: verificare ANTHROPIC_API_KEY.");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return fail("La chiave API di Anthropic non è autorizzata a usare il modello configurato.");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return fail("Il modello configurato non è disponibile: verificare SEGUITO_CLAUDE_MODEL.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return fail("Limite di richieste verso Anthropic raggiunto: riprovare tra qualche minuto.");
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return fail("L'analisi non si è conclusa entro il tempo massimo previsto: riprovare più tardi.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return fail("Impossibile contattare il servizio Anthropic: verificare la connessione a Internet e riprovare.");
  }
  if (error instanceof Anthropic.InternalServerError) {
    return fail(`Il servizio Anthropic è temporaneamente non disponibile (HTTP ${error.status}): riprovare più tardi.`);
  }
  if (error instanceof Anthropic.APIError) {
    return fail(`Il servizio Anthropic ha restituito un errore (HTTP ${error.status ?? "sconosciuto"}): ${error.message}`);
  }
  if (error instanceof Anthropic.AnthropicError) {
    return fail(`Errore del client Anthropic: ${error.message}`);
  }
  // Senza credenziali l'SDK lancia un Error generico, non una classe tipizzata.
  if (error instanceof Error && /authentication method/i.test(error.message)) {
    return fail("Chiave API di Anthropic non valida o mancante: verificare ANTHROPIC_API_KEY.");
  }
  return error instanceof Error ? error : fail("Errore imprevisto durante l'analisi della trascrizione.");
}
