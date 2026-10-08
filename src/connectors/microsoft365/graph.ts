/**
 * Client minimo per Microsoft Graph v1.0 (solo fetch): token dall'accesso
 * delegato, nuovi tentativi su 429/503/504 rispettando Retry-After, un rinnovo
 * del token su 401, errori tradotti in italiano senza contenuti della risposta.
 */
import { ConnectorError } from "../../actions/office.js";
import { Microsoft365AuthError } from "./auth.js";

export interface GraphClientOptions {
  /** Token di accesso; con `true` va rinnovato anche se non è in scadenza. */
  accessToken: (forceRefresh?: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Attesa tra i tentativi (sostituibile nei test). */
  sleep?: (ms: number) => Promise<void>;
}

const BASE_URL = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 60_000;
const RETRYABLE: ReadonlySet<number> = new Set([429, 502, 503, 504]);
/** Per le creazioni si ripete solo quando il servizio dichiara di non aver eseguito la richiesta. */
const RETRYABLE_POST: ReadonlySet<number> = new Set([429, 503]);

const MESSAGES = {
  unreachable: "Microsoft 365 non risponde: riprovare tra qualche minuto (le azioni non eseguite restano da approvare).",
  busy: "Microsoft 365 è sovraccarico e ha chiesto di riprovare più tardi: approvare di nuovo tra qualche minuto.",
  forbidden:
    "Permessi insufficienti su Microsoft 365: verificare che l'applicazione abbia Mail.ReadWrite e Calendars.ReadWrite " +
    "(e Mail.Send se la trascrizione va inviata), poi ricollegare l'account.",
  mailbox: "La casella dell'account collegato non è su Exchange Online: collegare l'account Microsoft 365 dello studio.",
  expired:
    "Il collegamento a Microsoft 365 non è più valido: ricollegarlo da Seguito («Collega Microsoft 365») e approvare di nuovo.",
} as const;

export class GraphClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: GraphClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Richiesta JSON; restituisce il corpo della risposta (null se vuoto, es. 202). */
  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.opts.accessToken(refreshed);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            ...headers,
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        if (attempt < MAX_ATTEMPTS && method !== "POST") {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new ConnectorError(MESSAGES.unreachable);
      }
      if (response.ok) {
        const text = await response.text();
        return text.trim() === "" ? null : (JSON.parse(text) as unknown);
      }
      // Token revocato prima della scadenza: un rinnovo, poi si chiede di ricollegare.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      const retryable = method === "POST" ? RETRYABLE_POST : RETRYABLE;
      if (retryable.has(response.status) && attempt < MAX_ATTEMPTS) {
        await this.sleep(retryAfter(response) ?? backoff(attempt));
        continue;
      }
      throw await graphError(response);
    }
  }
}

/** Errore di Graph per l'avvocato: stato HTTP e codice di Graph, mai il testo del server. */
async function graphError(response: Response): Promise<ConnectorError> {
  const json: unknown = await response.json().catch(() => null);
  const code =
    typeof json === "object" && json !== null && "error" in json && typeof json.error === "object" && json.error
      ? (json.error as { code?: unknown }).code
      : undefined;
  const graphCode = typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : null;
  if (response.status === 401) return new Microsoft365AuthError(MESSAGES.expired, "scaduto");
  if (response.status === 403) return new ConnectorError(MESSAGES.forbidden);
  if (graphCode === "MailboxNotEnabledForRESTAPI" || graphCode === "ResourceNotFound") {
    return new ConnectorError(MESSAGES.mailbox);
  }
  if (RETRYABLE.has(response.status)) return new ConnectorError(MESSAGES.busy);
  const detail = graphCode === null ? `HTTP ${response.status}` : `HTTP ${response.status}, ${graphCode}`;
  return new ConnectorError(`Microsoft 365 ha rifiutato l'operazione (${detail}): verificare i dati e riprovare.`);
}

/** Attesa indicata dal server (Retry-After in secondi), con un limite. */
function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : null;
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_WAIT_MS);
}
