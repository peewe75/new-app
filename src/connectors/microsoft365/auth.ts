/**
 * Accesso a Microsoft 365 per conto dell'avvocato: flusso OAuth 2.0 con codice
 * di autorizzazione e PKCE (Microsoft Entra ID, endpoint v2.0), applicazione
 * riservata con segreto. I token restano in un archivio dedicato (file 0600) e
 * vengono rinnovati da soli; nessun token compare nei messaggi o nei log.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { ConnectorError } from "../../actions/office.js";
import { writeFileAtomic } from "../../store/json-store.js";

/** Motivo di un collegamento non riuscito, mostrato dall'interfaccia con un testo fisso. */
export type AuthFailureReason = "annullato" | "scaduto" | "configurazione" | "errore";

/** Collegamento assente, scaduto o rifiutato: serve un nuovo accesso dall'interfaccia. */
export class Microsoft365AuthError extends ConnectorError {
  override name = "Microsoft365AuthError";

  constructor(
    message: string,
    readonly reason: AuthFailureReason = "errore",
  ) {
    super(message);
  }
}

export const StoredTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Scadenza del token di accesso, in millisecondi dall'epoca. */
  expiresAt: z.number(),
  account: z.object({ name: z.string().nullable(), username: z.string() }),
  connectedAt: z.string(),
});
export type StoredTokens = z.infer<typeof StoredTokensSchema>;

/** Dove conservare i token (file locale; in futuro un archivio cifrato). */
export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

/** Token in un file JSON leggibile solo dall'utente che esegue Seguito. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly file: string) {}

  async load(): Promise<StoredTokens | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      return StoredTokensSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(tokens, null, 2)}\n`);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

export interface Microsoft365AuthOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Permessi delegati richiesti (offline_access è aggiunto sempre). */
  scopes: readonly string[];
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Base degli endpoint di accesso (prove). */
  authority?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  /** Nome utente dell'account collegato (es. avvocato@studio.it). */
  account: string | null;
}

interface PendingAuthorization {
  verifier: string;
  createdAt: number;
}

const AUTHORITY = "https://login.microsoftonline.com";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName";
const TIMEOUT_MS = 30_000;
/** Il token di accesso si rinnova quando mancano meno di 5 minuti alla scadenza. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Una richiesta di collegamento resta valida 10 minuti. */
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive(),
});

const TokenErrorSchema = z.object({ error: z.string(), error_codes: z.array(z.number()).optional() });

const MeSchema = z.object({
  displayName: z.string().nullable().optional(),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string(),
});

const MESSAGES = {
  notConnected:
    "Microsoft 365 non è collegato: aprire Seguito e scegliere «Collega Microsoft 365», poi approvare di nuovo.",
  expired:
    "Il collegamento a Microsoft 365 è scaduto o è stato revocato: ricollegarlo da Seguito («Collega Microsoft 365») e approvare di nuovo.",
  stateInvalid: "Richiesta di collegamento scaduta o non valida: ripetere «Collega Microsoft 365».",
  cancelled: "Collegamento a Microsoft 365 annullato.",
  badClient:
    "Credenziali dell'applicazione Microsoft non valide: controllare SEGUITO_M365_CLIENT_ID e SEGUITO_M365_CLIENT_SECRET (il segreto potrebbe essere scaduto).",
  consent:
    "L'applicazione non ha ancora i permessi richiesti: un amministratore di Microsoft 365 deve concedere il consenso (vedi docs/microsoft365-setup.md).",
  unreachable: "Il servizio di accesso Microsoft non risponde: riprovare tra qualche minuto.",
  failed: "Accesso a Microsoft 365 non riuscito: riprovare. Se il problema persiste, consultare il registro del server.",
} as const;

export class Microsoft365Auth {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly authority: string;
  private readonly scope: string;
  private readonly pending = new Map<string, PendingAuthorization>();
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(private readonly opts: Microsoft365AuthOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.authority = `${opts.authority ?? AUTHORITY}/${encodeURIComponent(opts.tenantId)}/oauth2/v2.0`;
    this.scope = [...new Set(["offline_access", ...opts.scopes])].join(" ");
  }

  /** Indirizzo della pagina di accesso Microsoft per collegare l'account. */
  authorizationUrl(): string {
    this.prunePending();
    const state = randomToken();
    const verifier = randomToken();
    this.pending.set(state, { verifier, createdAt: this.now().getTime() });
    const params = new URLSearchParams({
      client_id: this.opts.clientId,
      response_type: "code",
      redirect_uri: this.opts.redirectUri,
      response_mode: "query",
      scope: this.scope,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `${this.authority}/authorize?${params.toString()}`;
  }

  /** Completa il collegamento con i parametri dell'indirizzo di ritorno; restituisce l'account collegato. */
  async complete(query: URLSearchParams): Promise<string> {
    const state = query.get("state") ?? "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    const error = query.get("error");
    if (error !== null) {
      if (error === "access_denied") throw new Microsoft365AuthError(MESSAGES.cancelled, "annullato");
      if (error === "consent_required" || error === "unauthorized_client") {
        throw new Microsoft365AuthError(MESSAGES.consent, "configurazione");
      }
      throw new Microsoft365AuthError(MESSAGES.failed);
    }
    const code = query.get("code");
    if (pending === undefined || this.isExpired(pending) || code === null || code === "") {
      throw new Microsoft365AuthError(MESSAGES.stateInvalid, "scaduto");
    }
    const tokens = await this.requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.opts.redirectUri,
      code_verifier: pending.verifier,
    });
    if (tokens.refresh_token === undefined) throw new Microsoft365AuthError(MESSAGES.failed);
    const account = await this.fetchAccount(tokens.access_token);
    await this.opts.tokenStore.save({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: this.expiry(tokens.expires_in),
      account,
      connectedAt: this.now().toISOString(),
    });
    return account.username;
  }

  async status(): Promise<ConnectionStatus> {
    const tokens = await this.opts.tokenStore.load();
    return { connected: tokens !== null, account: tokens?.account.username ?? null };
  }

  async disconnect(): Promise<void> {
    await this.opts.tokenStore.clear();
  }

  /** Token di accesso valido; con `forceRefresh` lo rinnova anche se non è in scadenza. */
  async accessToken(forceRefresh = false): Promise<string> {
    const tokens = await this.opts.tokenStore.load();
    if (tokens === null) throw new Microsoft365AuthError(MESSAGES.notConnected, "scaduto");
    if (!forceRefresh && tokens.expiresAt - this.now().getTime() > REFRESH_MARGIN_MS) return tokens.accessToken;
    // Rinnovi concorrenti accorpati: il token di rinnovo cambia a ogni uso.
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return (await this.refreshing).accessToken;
  }

  private async refresh(tokens: StoredTokens): Promise<StoredTokens> {
    let response: z.infer<typeof TokenResponseSchema>;
    try {
      response = await this.requestTokens({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    } catch (err) {
      // Collegamento revocato o scaduto: l'interfaccia torna a proporre «Collega Microsoft 365».
      if (err instanceof Microsoft365AuthError && err.reason === "scaduto") await this.opts.tokenStore.clear();
      throw err;
    }
    const updated: StoredTokens = {
      ...tokens,
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? tokens.refreshToken,
      expiresAt: this.expiry(response.expires_in),
    };
    await this.opts.tokenStore.save(updated);
    return updated;
  }

  private async requestTokens(params: Record<string, string>): Promise<z.infer<typeof TokenResponseSchema>> {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: this.scope,
      ...params,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.authority}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Microsoft365AuthError(MESSAGES.unreachable);
    }
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = TokenResponseSchema.safeParse(json);
      if (parsed.success) return parsed.data;
      throw new Microsoft365AuthError(MESSAGES.failed);
    }
    throw tokenError(json, params.grant_type === "refresh_token");
  }

  private async fetchAccount(accessToken: string): Promise<StoredTokens["account"]> {
    let response: Response;
    try {
      response = await this.fetchImpl(GRAPH_ME, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Microsoft365AuthError(MESSAGES.unreachable);
    }
    const parsed = MeSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) throw new Microsoft365AuthError(MESSAGES.failed);
    const me = parsed.data;
    return { name: me.displayName ?? null, username: me.mail?.trim() || me.userPrincipalName };
  }

  private expiry(expiresInSeconds: number): number {
    return this.now().getTime() + expiresInSeconds * 1000;
  }

  private isExpired(pending: PendingAuthorization): boolean {
    return this.now().getTime() - pending.createdAt > PENDING_TTL_MS;
  }

  private prunePending(): void {
    for (const [state, pending] of this.pending) {
      if (this.isExpired(pending)) this.pending.delete(state);
    }
    // Limite di sicurezza contro richieste ripetute: si tengono le più recenti.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}

/** Errore dell'endpoint dei token tradotto per l'avvocato (senza descrizioni del server). */
function tokenError(json: unknown, refreshing: boolean): Microsoft365AuthError {
  const parsed = TokenErrorSchema.safeParse(json);
  const error = parsed.success ? parsed.data.error : "";
  if (error === "invalid_client") return new Microsoft365AuthError(MESSAGES.badClient, "configurazione");
  if (error === "invalid_grant" || error === "interaction_required") {
    // AADSTS65001: consenso mancante per i permessi richiesti.
    if (parsed.success && parsed.data.error_codes?.includes(65001)) {
      return new Microsoft365AuthError(MESSAGES.consent, "configurazione");
    }
    return refreshing
      ? new Microsoft365AuthError(MESSAGES.expired, "scaduto")
      : new Microsoft365AuthError(MESSAGES.stateInvalid, "scaduto");
  }
  if (error === "unauthorized_client") return new Microsoft365AuthError(MESSAGES.consent, "configurazione");
  return new Microsoft365AuthError(MESSAGES.failed);
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
