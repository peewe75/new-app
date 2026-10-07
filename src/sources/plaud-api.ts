/**
 * Fonte Plaud tramite API sviluppatori (stessi endpoint di @plaud-ai/cli).
 * I token sono quelli salvati da "npx @plaud-ai/cli login"; vengono rinnovati
 * quando stanno per scadere e, una volta, quando Plaud rifiuta l'accesso (token
 * senza scadenza nota o revocato). Token e trascrizioni non sono mai registrati nei log.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Recording, RecordingRef } from "../domain/types.js";
import {
  discardBody,
  type HostResolver,
  loadBlockContent,
  parsePlaudFile,
  PlaudApiError,
  PlaudAuthError,
  plaudFetch,
  PlaudFileSchema,
  plaudFileRef,
  readBodyText,
  safeFetchText,
  selectRecent,
} from "./plaud-parse.js";
import type { RecordingSource } from "./source.js";

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
/** Il token si rinnova se scade entro questo margine. */
const REFRESH_MARGIN_MS = 60_000;

/** Formato di ~/.plaud/tokens.json; gli altri campi del file sono conservati. */
const StoredTokensSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().nullish(),
  token_type: z.string().nullish(),
  /** Scadenza in epoch ms. */
  expires_at: z.number().nullish(),
});
type StoredTokens = z.infer<typeof StoredTokensSchema>;

const RefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullish(),
  token_type: z.string().nullish(),
  /** Validità in secondi. */
  expires_in: z.number().nullish(),
});

const FileListSchema = z.object({ data: z.array(PlaudFileSchema).nullish() });

export interface PlaudApiSourceOptions {
  apiBase: string;
  tokensPath: string;
  refreshUrl: string;
  region: string | null;
  fetchImpl?: typeof fetch;
  /** Risoluzione dei nomi dei collegamenti `data_link` (sostituibile nei test). */
  resolveHost?: HostResolver;
  now?: () => Date;
}

export class PlaudApiSource implements RecordingSource {
  readonly name = "plaud" as const;
  private readonly apiBase: string;
  private readonly tokensPath: string;
  private readonly refreshUrl: string;
  private readonly region: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHost: HostResolver | undefined;
  private readonly now: () => Date;
  /** Lettura/rinnovo del token in corso, condivisa dalle richieste concorrenti. */
  private pendingToken: Promise<string> | null = null;
  /** Rinnovo forzato dopo un rifiuto, condiviso dalle richieste concorrenti. */
  private pendingRenewal: Promise<string> | null = null;

  constructor(opts: PlaudApiSourceOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.tokensPath = opts.tokensPath;
    this.refreshUrl = opts.refreshUrl;
    this.region = opts.region;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resolveHost = opts.resolveHost;
    this.now = opts.now ?? (() => new Date());
  }

  static fromConfig(config: AppConfig): PlaudApiSource {
    return new PlaudApiSource(config.plaud);
  }

  async listRecent(opts: { since?: Date; limit?: number } = {}): Promise<RecordingRef[]> {
    const sinceMs = opts.since?.getTime();
    const refs: RecordingRef[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageRefs = (await this.listPage(page)).map(plaudFileRef);
      refs.push(...pageRefs);
      const shortPage = pageRefs.length < PAGE_SIZE;
      const allBeforeSince =
        sinceMs !== undefined && pageRefs.every((ref) => Date.parse(ref.startedAt) < sinceMs);
      if (shortPage || allBeforeSince) break;
    }
    return selectRecent(refs, opts);
  }

  async fetchRecording(externalId: string): Promise<Recording> {
    const json = await this.getJson(
      `/open/third-party/files/${encodeURIComponent(externalId)}`,
      "la registrazione richiesta",
    );
    const parsed = PlaudFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("Risposta di Plaud in un formato inatteso: impossibile leggere la registrazione.");
    }
    const fetchLink = (url: string): Promise<string> =>
      safeFetchText(url, {
        fetchImpl: this.fetchImpl,
        ...(this.resolveHost === undefined ? {} : { resolveHost: this.resolveHost }),
      });
    return parsePlaudFile(parsed.data, (block) => loadBlockContent(block, fetchLink), this.now());
  }

  private async listPage(page: number) {
    const json = await this.getJson(
      `/open/third-party/files/?page=${page}&page_size=${PAGE_SIZE}`,
      "l'elenco delle registrazioni",
    );
    const parsed = FileListSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("Risposta di Plaud in un formato inatteso: impossibile leggere l'elenco delle registrazioni.");
    }
    return parsed.data.data ?? [];
  }

  /**
   * GET autenticato; `what` descrive la risorsa nei messaggi d'errore. Se Plaud
   * rifiuta il token, lo rinnova una volta e ripete la richiesta.
   */
  private async getJson(path: string, what: string): Promise<unknown> {
    let res = await this.authorizedGet(path, await this.accessToken());
    if (isAuthRejection(res)) {
      discardBody(res);
      res = await this.authorizedGet(path, await this.renewedAccessToken());
      if (isAuthRejection(res)) {
        discardBody(res);
        throw new PlaudAuthError();
      }
    }
    if (!res.ok) {
      discardBody(res);
      throw new PlaudApiError(res.status, `Impossibile ottenere ${what} da Plaud (HTTP ${res.status}).`);
    }
    return parseJson(await readBodyText(res), `Risposta di Plaud non valida per ${what}.`);
  }

  private authorizedGet(path: string, token: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (this.region) headers["x-pld-region"] = this.region;
    return plaudFetch(this.fetchImpl, `${this.apiBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private accessToken(): Promise<string> {
    this.pendingToken ??= this.resolveAccessToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  /** Token rinnovato con il refresh token salvato (PlaudAuthError se manca o è rifiutato). */
  private renewedAccessToken(): Promise<string> {
    this.pendingRenewal ??= this.readTokens()
      .then((stored) => this.refresh(stored))
      .finally(() => {
        this.pendingRenewal = null;
      });
    return this.pendingRenewal;
  }

  private async resolveAccessToken(): Promise<string> {
    const stored = await this.readTokens();
    const expiresAt = stored.expires_at;
    const expiring = typeof expiresAt === "number" && expiresAt - this.now().getTime() <= REFRESH_MARGIN_MS;
    return expiring ? this.refresh(stored) : stored.access_token;
  }

  private async readTokens(): Promise<StoredTokens> {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.tokensPath, "utf8"));
    } catch {
      json = null;
    }
    const parsed = StoredTokensSchema.safeParse(json);
    if (!parsed.success) {
      throw new PlaudAuthError(
        'Credenziali Plaud non trovate o non valide. Eseguire "npx @plaud-ai/cli login" e riprovare.',
      );
    }
    return parsed.data;
  }

  private async refresh(stored: StoredTokens): Promise<string> {
    if (!stored.refresh_token) {
      throw new PlaudAuthError('La sessione Plaud è scaduta. Eseguire "npx @plaud-ai/cli login" e riprovare.');
    }
    const res = await plaudFetch(this.fetchImpl, this.refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ refresh_token: stored.refresh_token }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 400 è la risposta OAuth standard per un refresh token non più valido.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      discardBody(res);
      throw new PlaudAuthError(
        'Plaud ha rifiutato il rinnovo dell\'accesso. Eseguire "npx @plaud-ai/cli login" e riprovare.',
      );
    }
    if (!res.ok) {
      discardBody(res);
      throw new PlaudApiError(res.status, `Impossibile rinnovare l'accesso a Plaud (HTTP ${res.status}).`);
    }
    const parsed = RefreshResponseSchema.safeParse(
      parseJson(await readBodyText(res), "Risposta di Plaud non valida al rinnovo dell'accesso."),
    );
    if (!parsed.success) {
      throw new Error("Risposta di Plaud in un formato inatteso al rinnovo dell'accesso.");
    }
    const next: StoredTokens = {
      ...stored,
      access_token: parsed.data.access_token,
      refresh_token: parsed.data.refresh_token ?? stored.refresh_token,
      token_type: parsed.data.token_type ?? stored.token_type,
    };
    if (typeof parsed.data.expires_in === "number") {
      next.expires_at = this.now().getTime() + parsed.data.expires_in * 1000;
    } else {
      delete next.expires_at;
    }
    await saveTokens(this.tokensPath, next);
    return next.access_token;
  }
}

function isAuthRejection(res: Response): boolean {
  return res.status === 401 || res.status === 403;
}

function parseJson(text: string, errorMessage: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(errorMessage);
  }
}

/** Scrittura atomica (file temporaneo + rename), file 0600 e cartella 0700. */
async function saveTokens(path: string, tokens: StoredTokens): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (cause) {
    await rm(tmp, { force: true });
    throw new Error("Impossibile salvare le credenziali Plaud rinnovate.", { cause });
  }
}
