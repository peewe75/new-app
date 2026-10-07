import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { StudioProfile } from "./domain/types.js";

export interface AppConfig {
  studio: StudioProfile;
  dataDir: string;
  outboxDir: string;
  /** File JSON del gestionale di riferimento (mock finché non c'è l'adattatore reale). */
  caseManagementFile: string;
  server: { host: string; port: number; password: string | null };
  claude: {
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    /** Limite di token in uscita per ogni analisi. */
    maxTokens: number;
    apiKeyPresent: boolean;
  };
  plaud: { apiBase: string; tokensPath: string; refreshUrl: string; region: string | null };
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function envOrNull(name: string): string | null {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : null;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_MAX_TOKENS = 16000;

export function loadConfig(): AppConfig {
  const lawyerName = env("SEGUITO_LAWYER_NAME", "Avv. Vincenzo Sapone");
  const studioName = env("SEGUITO_STUDIO_NAME", "Studio Legale Sapone");
  const effort = env("SEGUITO_CLAUDE_EFFORT", "high");
  const port = Number.parseInt(env("SEGUITO_PORT", "3000"), 10);
  const maxTokens = Number.parseInt(env("SEGUITO_CLAUDE_MAX_TOKENS", String(DEFAULT_MAX_TOKENS)), 10);
  return {
    studio: {
      studioName,
      lawyerName,
      lawyerEmail: env("SEGUITO_LAWYER_EMAIL", "avvocato@studio.example"),
      studioEmail: env("SEGUITO_STUDIO_EMAIL", "segreteria@studio.example"),
      timezone: env("SEGUITO_TIMEZONE", "Europe/Rome"),
      bookingLink: envOrNull("SEGUITO_BOOKING_LINK"),
      signature: env("SEGUITO_SIGNATURE", `${lawyerName}\n${studioName}`).replace(/\\n/g, "\n"),
    },
    dataDir: resolve(env("SEGUITO_DATA_DIR", "./data")),
    outboxDir: resolve(env("SEGUITO_OUTBOX_DIR", "./outbox")),
    caseManagementFile: resolve(env("SEGUITO_GESTIONALE_FILE", "./data/gestionale.json")),
    server: {
      host: env("SEGUITO_HOST", "127.0.0.1"),
      port: Number.isFinite(port) ? port : 3000,
      password: envOrNull("SEGUITO_PASSWORD"),
    },
    claude: {
      model: env("SEGUITO_CLAUDE_MODEL", "claude-opus-5-5"),
      effort: (EFFORTS as readonly string[]).includes(effort) ? (effort as AppConfig["claude"]["effort"]) : "high",
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
      apiKeyPresent: envOrNull("ANTHROPIC_API_KEY") !== null || envOrNull("ANTHROPIC_AUTH_TOKEN") !== null,
    },
    plaud: {
      apiBase: env("PLAUD_API_BASE", "https://platform.plaud.ai/developer/api"),
      tokensPath: expandHome(env("PLAUD_TOKENS_PATH", join(homedir(), ".plaud", "tokens.json"))),
      refreshUrl: env(
        "PLAUD_REFRESH_URL",
        "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh",
      ),
      region: envOrNull("PLAUD_REGION"),
    },
  };
}
