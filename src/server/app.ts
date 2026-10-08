/**
 * Server HTTP di Seguito: API JSON delle proposte, download dei file generati
 * (outbox) e interfaccia web di approvazione. Solo `node:http`, nessun framework.
 *
 * Sicurezza: intestazione Host limitata agli indirizzi IP, a localhost e ai nomi
 * autorizzati (contro il DNS rebinding), autenticazione HTTP Basic facoltativa su
 * ogni rotta, intestazioni restrittive (CSP senza script/stili inline), POST solo
 * JSON e solo dalla stessa origine, file dell'outbox serviti senza possibilità di
 * uscire dalla cartella.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { ApprovalRequestSchema, type ApprovalRequest, type Proposal, type StudioProfile } from "../domain/types.js";
import type { PhoneUpload, ReceiveMeta } from "../phone/phone-inbox.js";
import type { Store } from "../store/store.js";

export interface AppServices {
  store: Store;
  studio: StudioProfile;
  /** Cartella dei file generati (.ics, .eml), servita sotto /outbox/. */
  outboxDir: string;
  /** Se impostata, ogni richiesta richiede l'autenticazione HTTP Basic. */
  password: string | null;
  /**
   * Nomi host accettati nell'intestazione Host oltre agli indirizzi IP e a
   * localhost (difesa dal DNS rebinding), es. "seguito.studio.lan".
   */
  allowedHosts?: readonly string[];
  approve(proposalId: string, request: ApprovalRequest): Promise<Proposal>;
  discard(proposalId: string): Promise<Proposal>;
  /** Sincronizzazione con la fonte delle registrazioni; assente se non configurata. */
  sync?: () => Promise<{ processed: number; skipped: number; errors: string[] }>;
  /** Collegamento a Microsoft 365 (calendario e bozze); assente se non configurato. */
  microsoft365?: Microsoft365Services;
  /** Ricezione delle chiamate registrate con lo smartphone; assente se non configurata. */
  phone?: PhoneServices;
}

export interface PhoneServices {
  /** Dimensione massima di una registrazione, in byte. */
  readonly maxBytes: number;
  receive(body: Readable, meta: ReceiveMeta): Promise<{ upload: PhoneUpload; created: boolean }>;
  get(id: string): Promise<PhoneUpload | null>;
  list(): Promise<PhoneUpload[]>;
  retry(id: string): Promise<PhoneUpload>;
}

/** Tipi di contenuto accettati per l'audio inviato dal telefono. */
const AUDIO_TYPE = /^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/;

export interface Microsoft365Services {
  /** Origine dell'indirizzo di ritorno registrato: il collegamento si avvia solo da lì. */
  readonly redirectOrigin: string;
  status(): Promise<{ connected: boolean; account: string | null }>;
  /** Pagina di accesso Microsoft a cui inviare il browser. */
  authorizationUrl(): string;
  /** Completa l'accesso con i parametri dell'indirizzo di ritorno. */
  complete(query: URLSearchParams): Promise<string>;
  disconnect(): Promise<void>;
}

/** Esiti del collegamento a Microsoft 365 comunicati all'interfaccia (testi fissi lato interfaccia). */
const MICROSOFT_OUTCOMES: ReadonlySet<string> = new Set(["collegato", "annullato", "scaduto", "configurazione", "errore"]);

/** Riga dell'elenco proposte (GET /api/proposals). */
export interface ProposalSummary {
  id: string;
  status: Proposal["status"];
  title: string;
  startedAt: string;
  durationMs: number | null;
  conversationType: Proposal["conversationType"];
  summary: string;
  actionsCount: number;
  preselectedCount: number;
  warningCodes: string[];
  hasBlocking: boolean;
  /** Scadenze proposte e non ancora inserite in calendario. */
  pendingDeadlines: number;
}

type SyncResult = Awaited<ReturnType<NonNullable<AppServices["sync"]>>>;

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
const MAX_BODY_BYTES = 1024 * 1024;

/** Unici file serviti da /static/ (nessun altro file della cartella è raggiungibile). */
const UI_FILES: ReadonlyMap<string, string> = new Map([
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["manifest.webmanifest", "application/manifest+json"],
  ["icon.svg", "image/svg+xml"],
]);

const DOWNLOAD_TYPES: ReadonlyMap<string, string> = new Map([
  [".ics", "text/calendar; charset=utf-8"],
  [".eml", "message/rfc822"],
  [".txt", "text/plain; charset=utf-8"],
]);

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

const MESSAGES = {
  badUrl: "Indirizzo della richiesta non valido.",
  badHost:
    "Richiesta rifiutata: nome host non autorizzato. Per raggiungere Seguito con questo nome, aggiungerlo a SEGUITO_ALLOWED_HOSTS.",
  unauthorized: "Accesso riservato: inserire la password di Seguito.",
  crossOrigin: "Richiesta rifiutata: proviene da un'origine diversa da Seguito.",
  notFound: "Risorsa non trovata.",
  proposalNotFound: "Proposta non trovata.",
  fileNotFound: "File non trovato.",
  badFilePath: "Percorso del file non valido.",
  syncUnavailable: "La sincronizzazione delle registrazioni non è configurata.",
  phoneUnavailable:
    "La ricezione delle registrazioni dal telefono non è configurata: servono la chiave di Claude e il servizio di trascrizione (vedi docs/telefono-samsung.md).",
  phoneNeedsPassword:
    "Per ricevere le registrazioni dal telefono impostare SEGUITO_PASSWORD: l'invio dell'audio richiede sempre la password.",
  phoneNotAudio: "Il corpo della richiesta deve essere un file audio (Content-Type audio/... o application/octet-stream).",
  phoneNoName: "Indicare il nome del file nel parametro «nome».",
  phoneBadKind: "Tipo di registrazione non valido: «chiamata» oppure «vocale».",
  phoneNotFound: "Registrazione non trovata.",
  microsoftUnavailable:
    "Microsoft 365 non è configurato: impostare SEGUITO_M365_TENANT_ID, SEGUITO_M365_CLIENT_ID e SEGUITO_M365_CLIENT_SECRET.",
  methodNotAllowed: "Metodo non consentito per questo indirizzo.",
  busy: "È già in corso un'operazione su questa proposta: attendere che sia completata.",
  tooLarge: "Il corpo della richiesta supera il limite di 1 MB.",
  notJson: "Le richieste POST devono avere Content-Type: application/json.",
  invalidJson: "Il corpo della richiesta non è un JSON valido.",
  noActions: "Selezionare almeno un'azione da approvare.",
  aborted: "La richiesta è stata interrotta.",
  stateConflict: "Operazione non consentita nello stato attuale della proposta.",
  invalidApproval: "Richiesta di approvazione non valida.",
  internal: "Si è verificato un errore interno. Riprovare; se il problema persiste, consultare il registro del server.",
} as const;

/** Errore con stato HTTP e messaggio (in italiano) mostrabile all'utente. */
class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

interface Route {
  method: "GET" | "POST";
  /** POST con un file nel corpo (audio dal telefono) invece di JSON. */
  upload?: boolean;
  run(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

interface AppContext {
  services: AppServices;
  /** Nomi host autorizzati (minuscoli), oltre a indirizzi IP e localhost. */
  allowedHosts: ReadonlySet<string>;
  /** Esegue un'operazione in esclusiva sulla proposta (409 se ne è già in corso una). */
  exclusive<T>(proposalId: string, task: () => Promise<T>): Promise<T>;
  /** Sincronizzazione con le richieste concorrenti accorpate; null se non configurata. */
  sync: (() => Promise<SyncResult>) | null;
}

/** Crea il server (non ancora in ascolto). */
export function createAppServer(services: AppServices): Server {
  const ctx: AppContext = {
    services,
    allowedHosts: new Set((services.allowedHosts ?? []).map((host) => host.trim().toLowerCase())),
    exclusive: createExclusiveRunner(),
    sync: services.sync ? singleFlight(services.sync) : null,
  };
  // Una registrazione lunga inviata da fuori studio (Tailscale, rete lenta) può
  // richiedere più dei 5 minuti predefiniti di Node: si tollera fino a 64 KB/s.
  const requestTimeout = Math.max(DEFAULT_REQUEST_TIMEOUT_MS, Math.ceil((services.phone?.maxBytes ?? 0) / MIN_UPLOAD_BYTES_PER_MS));
  return createServer({ requestTimeout }, (req, res) => {
    void handleRequest(ctx, req, res);
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MIN_UPLOAD_BYTES_PER_MS = 64;

async function handleRequest(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.setHeader("Cache-Control", "no-store");
    assertAllowedHost(req.headers.host, ctx.allowedHosts);
    const password = ctx.services.password;
    if (password && !isAuthorized(req.headers.authorization, password)) {
      throw new HttpError(401, MESSAGES.unauthorized, { "WWW-Authenticate": 'Basic realm="Seguito", charset="UTF-8"' });
    }
    const route = findRoute(ctx, pathSegments(req.url));
    if (route === null) throw new HttpError(404, MESSAGES.notFound);
    const method = req.method === "HEAD" ? "GET" : req.method;
    if (method !== route.method) {
      throw new HttpError(405, MESSAGES.methodNotAllowed, { Allow: route.method === "GET" ? "GET, HEAD" : "POST" });
    }
    if (route.method === "POST") {
      if (route.upload === true) assertUploadRequest(req);
      else assertSameOriginJson(req);
    }
    await route.run(req, res);
  } catch (err) {
    sendFailure(res, err);
  }
}

// ---------------------------------------------------------------------------
// Instradamento
// ---------------------------------------------------------------------------

/** Segmenti del percorso grezzo (non normalizzato), decodificati uno per uno. */
function pathSegments(url: string | undefined): string[] {
  const raw = url ?? "/";
  const queryStart = raw.indexOf("?");
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  if (!path.startsWith("/")) throw new HttpError(400, MESSAGES.badUrl);
  try {
    return path.slice(1).split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    throw new HttpError(400, MESSAGES.badUrl);
  }
}

function get(run: Route["run"]): Route {
  return { method: "GET", run };
}

function post(run: Route["run"]): Route {
  return { method: "POST", run };
}

function findRoute(ctx: AppContext, segments: readonly string[]): Route | null {
  const [first, second, third, fourth] = segments;
  const count = segments.length;
  if (count === 1 && first === "") return get((_req, res) => serveUiFile(res, "index.html"));
  if (first === "static" && count === 2 && second !== undefined) return get((_req, res) => serveUiFile(res, second));
  if (first === "outbox") return get((_req, res) => serveOutboxFile(res, ctx.services.outboxDir, segments.slice(1)));
  if (first === "auth" && second === "microsoft") {
    if (count === 2) return get((req, res) => startMicrosoftLogin(ctx, req, res));
    if (count === 3 && third === "callback") return get((req, res) => finishMicrosoftLogin(ctx, req, res));
    return null;
  }
  if (first !== "api") return null;
  if (count === 2 && second === "health") return get(async (_req, res) => sendJson(res, 200, { ok: true }));
  if (count === 2 && second === "config") return get(async (_req, res) => sendJson(res, 200, await publicConfig(ctx)));
  if (count === 2 && second === "sync") return post((_req, res) => runSync(ctx, res));
  if (count === 3 && second === "microsoft365" && third === "disconnect") {
    return post((_req, res) => disconnectMicrosoft(ctx, res));
  }
  if (second === "telefono" && third === "registrazioni") return phoneRoute(ctx, segments.slice(3));
  if (second !== "proposals") return null;
  if (count === 2) return get((_req, res) => listProposals(ctx, res));
  if (third === undefined || third === "") return null;
  if (count === 3) return get((_req, res) => proposalDetail(ctx, res, third));
  if (count === 4 && fourth === "approve") return post((req, res) => approveProposal(ctx, req, res, third));
  if (count === 4 && fourth === "discard") return post((_req, res) => discardProposal(ctx, res, third));
  return null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function publicConfig(ctx: AppContext): Promise<Record<string, unknown>> {
  const { studio, microsoft365 } = ctx.services;
  return {
    studioName: studio.studioName,
    lawyerName: studio.lawyerName,
    timezone: studio.timezone,
    syncAvailable: ctx.sync !== null,
    phoneAvailable: ctx.services.phone !== undefined,
    // null: Microsoft 365 non configurato; altrimenti stato del collegamento.
    microsoft365:
      microsoft365 === undefined
        ? null
        : { ...(await microsoft365.status()), redirectOrigin: microsoft365.redirectOrigin },
  };
}

function requireMicrosoft(ctx: AppContext): Microsoft365Services {
  const microsoft = ctx.services.microsoft365;
  if (microsoft === undefined) throw new HttpError(404, MESSAGES.microsoftUnavailable);
  return microsoft;
}

/**
 * Avvio del collegamento solo dall'interfaccia di Seguito o digitando l'indirizzo:
 * una pagina esterna non deve poter generare richieste di accesso (che
 * scalzerebbero quella in corso dell'avvocato).
 */
async function startMicrosoftLogin(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, MESSAGES.crossOrigin);
  const url = requireMicrosoft(ctx).authorizationUrl();
  res.writeHead(302, { Location: url });
  res.end();
}

/** Ritorno dalla pagina di accesso Microsoft: l'esito torna all'interfaccia come codice, mai come testo libero. */
async function finishMicrosoftLogin(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const microsoft = requireMicrosoft(ctx);
  const query = new URL(req.url ?? "/", "http://seguito.invalid").searchParams;
  let outcome = "collegato";
  try {
    await microsoft.complete(query);
  } catch (err) {
    const reason = err instanceof Error && "reason" in err ? String(err.reason) : "";
    outcome = MICROSOFT_OUTCOMES.has(reason) ? reason : "errore";
    if (outcome === "errore") console.error("[seguito] Collegamento a Microsoft 365 non riuscito:", err);
  }
  res.writeHead(302, { Location: `/?microsoft365=${outcome}` });
  res.end();
}

// ---------------------------------------------------------------------------
// Registrazioni dal telefono
// ---------------------------------------------------------------------------

function phoneRoute(ctx: AppContext, rest: readonly string[]): Route | null {
  const [id, action] = rest;
  if (rest.length === 0) {
    return { method: "POST", upload: true, run: (req, res) => receivePhoneRecording(ctx, req, res) };
  }
  if (rest.length === 1 && id === "elenco") return get(async (_req, res) => listPhoneRecordings(ctx, res));
  if (rest.length === 1 && id) return get(async (_req, res) => phoneRecordingStatus(ctx, res, id));
  if (rest.length === 2 && id && action === "riprova") return post(async (_req, res) => retryPhoneRecording(ctx, res, id));
  return null;
}

function requirePhone(ctx: AppContext): PhoneServices {
  const phone = ctx.services.phone;
  if (phone === undefined) throw new HttpError(503, MESSAGES.phoneUnavailable);
  return phone;
}

/** Dati della registrazione per il telefono: niente trascrizione né dati del cliente oltre al titolo. */
function phoneView(upload: PhoneUpload): Record<string, unknown> {
  return {
    id: upload.id,
    kind: upload.kind,
    title: upload.title,
    status: upload.status,
    message: upload.message,
    proposalId: upload.proposalId,
    receivedAt: upload.receivedAt,
    startedAt: upload.startedAt,
    nextAttemptAt: upload.nextAttemptAt,
  };
}

async function receivePhoneRecording(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // La password, verificata da handleRequest su ogni richiesta, qui è obbligatoria.
  if (ctx.services.password === null) throw new HttpError(403, MESSAGES.phoneNeedsPassword);
  const phone = requirePhone(ctx);
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > phone.maxBytes) {
    throw new HttpError(413, `La registrazione supera il limite di ${Math.floor(phone.maxBytes / (1024 * 1024))} MB.`);
  }
  const query = new URL(req.url ?? "/", "http://seguito.invalid").searchParams;
  const fileName = query.get("nome")?.trim() ?? "";
  if (fileName === "") throw new HttpError(400, MESSAGES.phoneNoName);
  const kind = query.get("tipo")?.trim() || "chiamata";
  if (kind !== "chiamata" && kind !== "vocale") throw new HttpError(400, MESSAGES.phoneBadKind);
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const { upload, created } = await phone.receive(req, {
    fileName,
    contentType,
    kind,
    title: query.get("titolo"),
    lastModifiedMs: boundedMs(query.get("modificato"), MAX_DATE_MS),
    durationMs: boundedMs(query.get("durata"), MAX_CALL_MS),
  });
  sendJson(res, created ? 201 : 200, phoneView(upload));
}

async function phoneRecordingStatus(ctx: AppContext, res: ServerResponse, id: string): Promise<void> {
  const upload = await requirePhone(ctx).get(id);
  if (upload === null) throw new HttpError(404, MESSAGES.phoneNotFound);
  sendJson(res, 200, phoneView(upload));
}

async function listPhoneRecordings(ctx: AppContext, res: ServerResponse): Promise<void> {
  sendJson(res, 200, (await requirePhone(ctx).list()).map(phoneView));
}

async function retryPhoneRecording(ctx: AppContext, res: ServerResponse, id: string): Promise<void> {
  sendJson(res, 200, phoneView(await requirePhone(ctx).retry(id)));
}

/** Data valida più lontana per JavaScript e durata massima plausibile di una chiamata, in ms. */
const MAX_DATE_MS = 8.64e15;
const MAX_CALL_MS = 7 * 24 * 60 * 60_000;

/** Millisecondi interi tra 0 e `max`; altrimenti null (valore assente o non plausibile). */
function boundedMs(value: string | null, max: number): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

async function disconnectMicrosoft(ctx: AppContext, res: ServerResponse): Promise<void> {
  await requireMicrosoft(ctx).disconnect();
  sendJson(res, 200, { ok: true });
}

function summarize(proposal: Proposal): ProposalSummary {
  const warnings = [...proposal.warnings, ...proposal.actions.flatMap((action) => action.warnings)];
  return {
    id: proposal.id,
    status: proposal.status,
    title: proposal.recording.title,
    startedAt: proposal.recording.startedAt,
    durationMs: proposal.recording.durationMs,
    conversationType: proposal.conversationType,
    summary: proposal.summary,
    actionsCount: proposal.actions.length,
    preselectedCount: proposal.actions.filter((action) => action.preselected).length,
    warningCodes: [...new Set(warnings.map((warning) => warning.code))],
    hasBlocking: warnings.some((warning) => warning.severity === "bloccante"),
    pendingDeadlines: pendingDeadlines(proposal),
  };
}

function pendingDeadlines(proposal: Proposal): number {
  const done = new Set(proposal.executions.filter((e) => e.status === "ok").map((e) => e.actionId));
  return proposal.actions.filter((action) => action.payload.type === "scadenza" && !done.has(action.id)).length;
}

async function listProposals(ctx: AppContext, res: ServerResponse): Promise<void> {
  const proposals = await ctx.services.store.listProposals();
  sendJson(res, 200, proposals.map(summarize));
}

async function requireProposal(store: Store, id: string): Promise<Proposal> {
  const proposal = await store.getProposal(id);
  if (proposal === null) throw new HttpError(404, MESSAGES.proposalNotFound);
  return proposal;
}

async function proposalDetail(ctx: AppContext, res: ServerResponse, id: string): Promise<void> {
  const { store } = ctx.services;
  const proposal = await requireProposal(store, id);
  const recording = await store.getRecording(proposal.recordingId);
  sendJson(res, 200, {
    proposal,
    transcript: {
      title: recording?.title ?? proposal.recording.title,
      startedAt: recording?.startedAt ?? proposal.recording.startedAt,
      segments: recording?.segments ?? [],
    },
  });
}

async function approveProposal(ctx: AppContext, req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const parsed = ApprovalRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) throw new HttpError(400, invalidApprovalMessage(parsed.error.issues));
  if (parsed.data.actionIds.length === 0) throw new HttpError(400, MESSAGES.noActions);
  await requireProposal(ctx.services.store, id);
  const proposal = await ctx.exclusive(id, () => ctx.services.approve(id, parsed.data));
  sendJson(res, 200, proposal);
}

async function discardProposal(ctx: AppContext, res: ServerResponse, id: string): Promise<void> {
  await requireProposal(ctx.services.store, id);
  const proposal = await ctx.exclusive(id, () => ctx.services.discard(id));
  sendJson(res, 200, proposal);
}

async function runSync(ctx: AppContext, res: ServerResponse): Promise<void> {
  if (ctx.sync === null) throw new HttpError(404, MESSAGES.syncUnavailable);
  sendJson(res, 200, await ctx.sync());
}

function invalidApprovalMessage(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [...new Set(issues.map((issue) => issue.path.map(String).join(".") || "corpo"))].slice(0, 5);
  return fields.length > 0 ? `${MESSAGES.invalidApproval} Campi da correggere: ${fields.join(", ")}.` : MESSAGES.invalidApproval;
}

function createExclusiveRunner(): AppContext["exclusive"] {
  const busy = new Set<string>();
  return async (proposalId, task) => {
    if (busy.has(proposalId)) throw new HttpError(409, MESSAGES.busy);
    busy.add(proposalId);
    try {
      return await task();
    } finally {
      busy.delete(proposalId);
    }
  };
}

/** Le chiamate concorrenti condividono la stessa esecuzione in corso. */
function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= Promise.resolve()
      .then(task)
      .finally(() => {
        running = null;
      });
    return running;
  };
}

// ---------------------------------------------------------------------------
// Richieste in ingresso
// ---------------------------------------------------------------------------

/**
 * DNS rebinding: una pagina esterna che fa risolvere il proprio nome in
 * 127.0.0.1 arriva qui con il suo nome nell'intestazione Host. Si accettano
 * solo indirizzi IP (la pagina avrebbe allora la stessa origine di Seguito),
 * localhost e i nomi autorizzati.
 */
function assertAllowedHost(header: string | undefined, allowed: ReadonlySet<string>): void {
  const hostname = hostnameOf(header);
  if (hostname !== null && (isIP(hostname) !== 0 || hostname === "localhost" || allowed.has(hostname))) return;
  throw new HttpError(403, MESSAGES.badHost);
}

/** "nome[:porta]" oppure "[IPv6][:porta]"; nient'altro (niente credenziali né percorsi). */
const HOST_HEADER = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d{1,5})?$/i;

/** Nome host (minuscolo, IPv6 senza parentesi) dall'intestazione Host; null se assente o non valida. */
function hostnameOf(header: string | undefined): string | null {
  const match = HOST_HEADER.exec(header ?? "");
  if (match === null) return null;
  return (match[1] ?? match[2] ?? "").toLowerCase();
}

function isAuthorized(header: string | undefined, password: string): boolean {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (match?.[1] === undefined) return false;
  const credentials = Buffer.from(match[1], "base64").toString("utf8");
  const colon = credentials.indexOf(":");
  if (colon === -1) return false;
  return equalSecrets(credentials.slice(colon + 1), password);
}

/** Confronto a tempo costante: gli hash hanno sempre la stessa lunghezza. */
function equalSecrets(given: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Invio dell'audio dal telefono: solo con la password di Seguito impostata (il
 * telefono la invia a ogni richiesta), solo file audio e mai da un'altra origine
 * (i browser non possono inviare questo tipo di contenuto a un altro sito senza
 * un permesso CORS, che Seguito non concede).
 */
function assertUploadRequest(req: IncomingMessage): void {
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!AUDIO_TYPE.test(mediaType)) throw new HttpError(415, MESSAGES.phoneNotAudio);
  assertSameOriginIfPresent(req);
}

/** POST accettati solo come JSON e, se il browser indica l'origine, dalla stessa origine. */
function assertSameOriginJson(req: IncomingMessage): void {
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new HttpError(415, MESSAGES.notJson);
  assertSameOriginIfPresent(req);
}

function assertSameOriginIfPresent(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let originHost: string | null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost === null || originHost !== req.headers.host) throw new HttpError(403, MESSAGES.crossOrigin);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new HttpError(413, MESSAGES.tooLarge));
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      rejectBody(error);
    };
    // Oltre il limite i dati restanti vengono letti e scartati, così la risposta 413 arriva al client.
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) fail(new HttpError(413, MESSAGES.tooLarge));
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on("error", fail);
    req.on("close", () => {
      if (!req.complete) fail(new HttpError(400, MESSAGES.aborted));
    });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, MESSAGES.invalidJson);
  }
}

// ---------------------------------------------------------------------------
// File statici e outbox
// ---------------------------------------------------------------------------

async function serveUiFile(res: ServerResponse, name: string): Promise<void> {
  const contentType = UI_FILES.get(name);
  if (contentType === undefined) throw new HttpError(404, MESSAGES.notFound);
  let content: Buffer;
  try {
    content = await readFile(join(UI_DIR, name));
  } catch {
    throw new HttpError(404, MESSAGES.notFound);
  }
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": content.length, "Cache-Control": "no-cache" });
  res.end(content);
}

/** Segmento accettabile: non vuoto, senza separatori né caratteri di controllo, non nascosto (né "." o ".."). */
function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 && !segment.startsWith(".") && !/[/\\\u0000-\u001f\u007f]/.test(segment);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function serveOutboxFile(res: ServerResponse, outboxDir: string, segments: readonly string[]): Promise<void> {
  if (segments.length === 0) throw new HttpError(404, MESSAGES.fileNotFound);
  if (!segments.every(isSafePathSegment)) throw new HttpError(400, MESSAGES.badFilePath);
  const root = resolve(outboxDir);
  const target = resolve(root, ...segments);
  if (!isInside(root, target)) throw new HttpError(400, MESSAGES.badFilePath);
  // Il percorso reale (link simbolici risolti) deve restare dentro l'outbox reale.
  const realRoot = await realpathOrNull(root);
  const realTarget = await realpathOrNull(target);
  if (realRoot === null || realTarget === null || !isInside(realRoot, realTarget)) {
    throw new HttpError(404, MESSAGES.fileNotFound);
  }
  if (!(await stat(realTarget)).isFile()) throw new HttpError(404, MESSAGES.fileNotFound);
  const content = await readFile(realTarget);
  const fileName = basename(target);
  res.writeHead(200, {
    "Content-Type": DOWNLOAD_TYPES.get(extname(fileName).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": content.length,
    "Content-Disposition": attachmentDisposition(fileName),
  });
  res.end(content);
}

/** Content-Disposition con nome ASCII di ripiego e nome UTF-8 (RFC 6266 / RFC 5987). */
function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ---------------------------------------------------------------------------
// Risposte
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function describeFailure(err: unknown): { status: number; message: string; headers: Readonly<Record<string, string>> } {
  if (err instanceof HttpError) return { status: err.status, message: err.message, headers: err.headers };
  // Errori del flusso di approvazione riconosciuti per nome, senza dipendere dal modulo che li definisce.
  if (err instanceof Error && err.name === "ProposalStateError") {
    return { status: 409, message: err.message || MESSAGES.stateConflict, headers: {} };
  }
  if (err instanceof Error && err.name === "ApprovalValidationError") {
    return { status: 400, message: err.message || MESSAGES.invalidApproval, headers: {} };
  }
  if (err instanceof Error && err.name === "PhoneUploadError" && "status" in err && typeof err.status === "number") {
    return { status: err.status, message: err.message, headers: {} };
  }
  return { status: 500, message: MESSAGES.internal, headers: {} };
}

function sendFailure(res: ServerResponse, err: unknown): void {
  const failure = describeFailure(err);
  if (failure.status >= 500) console.error("[seguito] Errore durante la gestione della richiesta:", err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, failure.status, { error: failure.message }, failure.headers);
}
