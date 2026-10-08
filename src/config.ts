import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { StudioProfile } from "./domain/types.js";
import { SPEECHMATICS_EU_URL } from "./transcribe/speechmatics.js";

export interface AppConfig {
  studio: StudioProfile;
  dataDir: string;
  outboxDir: string;
  /** File JSON del gestionale di riferimento (mock finché non c'è l'adattatore reale). */
  caseManagementFile: string;
  server: {
    host: string;
    port: number;
    password: string | null;
    /** Nomi host con cui si raggiunge l'interfaccia, oltre agli indirizzi IP e a localhost. */
    allowedHosts: string[];
  };
  claude: {
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    /** Limite di token in uscita per ogni analisi. */
    maxTokens: number;
    apiKeyPresent: boolean;
  };
  plaud: { apiBase: string; tokensPath: string; refreshUrl: string; region: string | null };
  microsoft365: Microsoft365Config;
  phone: PhoneConfig;
}

/** Chiamate registrate con lo smartphone, trascritte da Speechmatics (regione UE). */
export interface PhoneConfig {
  /** Cartella delle registrazioni ricevute (stato e audio in attesa di trascrizione). */
  dir: string;
  /** Dimensione massima di una registrazione, in byte. */
  maxBytes: number;
  speechmatics: {
    apiKey: string | null;
    /** Indirizzo dell'API: regione UE salvo diversa indicazione. */
    url: string;
    /** Parole in più da riconoscere (nomi di clienti ricorrenti, termini tecnici). */
    vocabulary: string[];
  };
}

/** Collegamento a Microsoft 365 (bozze in Outlook ed eventi nel calendario). */
export interface Microsoft365Config {
  /** true quando tenant, id e segreto dell'applicazione sono tutti indicati. */
  configured: boolean;
  tenantId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  /** Indirizzo di ritorno registrato nell'applicazione Microsoft Entra. */
  redirectUri: string;
  /** File con i token di accesso (permessi 0600). */
  tokensFile: string;
  /** Trascrizione alla casella dello studio: bozza (predefinito) oppure invio diretto. */
  transcriptDelivery: "bozza" | "invio";
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
const DEFAULT_PHONE_MAX_MB = 500;

export function loadConfig(): AppConfig {
  const lawyerName = env("SEGUITO_LAWYER_NAME", "Avv. Vincenzo Sapone");
  const studioName = env("SEGUITO_STUDIO_NAME", "Studio Legale Sapone");
  const effort = env("SEGUITO_CLAUDE_EFFORT", "high");
  const port = Number.parseInt(env("SEGUITO_PORT", "3000"), 10);
  const maxTokens = Number.parseInt(env("SEGUITO_CLAUDE_MAX_TOKENS", String(DEFAULT_MAX_TOKENS)), 10);
  const dataDir = resolve(env("SEGUITO_DATA_DIR", "./data"));
  const serverPort = Number.isFinite(port) ? port : 3000;
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
    dataDir,
    outboxDir: resolve(env("SEGUITO_OUTBOX_DIR", "./outbox")),
    caseManagementFile: resolve(env("SEGUITO_GESTIONALE_FILE", "./data/gestionale.json")),
    server: {
      host: env("SEGUITO_HOST", "127.0.0.1"),
      port: serverPort,
      password: envOrNull("SEGUITO_PASSWORD"),
      allowedHosts: env("SEGUITO_ALLOWED_HOSTS", "")
        .split(",")
        .map((host) => host.trim())
        .filter((host) => host !== ""),
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
    microsoft365: microsoft365Config(dataDir, serverPort),
    phone: phoneConfig(dataDir),
  };
}

function phoneConfig(dataDir: string): PhoneConfig {
  const maxMb = Number(env("SEGUITO_TELEFONO_MAX_MB", String(DEFAULT_PHONE_MAX_MB)).replace(",", "."));
  return {
    dir: join(dataDir, "telefono"),
    maxBytes: Math.floor((Number.isFinite(maxMb) && maxMb > 0 ? maxMb : DEFAULT_PHONE_MAX_MB) * 1024 * 1024),
    speechmatics: {
      apiKey: envOrNull("SPEECHMATICS_API_KEY"),
      url: env("SPEECHMATICS_URL", SPEECHMATICS_EU_URL),
      vocabulary: env("SEGUITO_TELEFONO_VOCABOLARIO", "")
        .split(",")
        .map((word) => word.trim())
        .filter((word) => word !== ""),
    },
  };
}

function microsoft365Config(dataDir: string, port: number): Microsoft365Config {
  const tenantId = envOrNull("SEGUITO_M365_TENANT_ID");
  const clientId = envOrNull("SEGUITO_M365_CLIENT_ID");
  const clientSecret = envOrNull("SEGUITO_M365_CLIENT_SECRET");
  return {
    configured: tenantId !== null && clientId !== null && clientSecret !== null,
    tenantId,
    clientId,
    clientSecret,
    redirectUri: env("SEGUITO_M365_REDIRECT_URI", `http://localhost:${port}/auth/microsoft/callback`),
    tokensFile: resolve(expandHome(env("SEGUITO_M365_TOKENS_FILE", join(dataDir, "microsoft365.json")))),
    transcriptDelivery: env("SEGUITO_TRASCRIZIONE", "bozza").toLowerCase() === "invio" ? "invio" : "bozza",
  };
}
