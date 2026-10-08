import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExecutors } from "../src/actions/executors.js";
import { ConnectorError, type CalendarEventSpec, type MessageSpec, type OfficeTarget } from "../src/actions/office.js";
import { approveProposal } from "../src/actions/run.js";
import type { Microsoft365Config } from "../src/config.js";
import { FileTokenStore, Microsoft365Auth, Microsoft365AuthError, type StoredTokens, type TokenStore } from "../src/connectors/microsoft365/auth.js";
import { GraphClient } from "../src/connectors/microsoft365/graph.js";
import { createMicrosoft365, microsoft365Scopes } from "../src/connectors/microsoft365/index.js";
import { Microsoft365Office } from "../src/connectors/microsoft365/office.js";
import type { Proposal, Recording, StudioProfile } from "../src/domain/types.js";
import { JsonCaseManagement } from "../src/enrich/json-case-management.js";
import { FixtureExtractor } from "../src/extract/fixture-extractor.js";
import { processRecording } from "../src/pipeline.js";
import { FileSource } from "../src/sources/file-source.js";
import { JsonFileStore } from "../src/store/json-store.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NOW = new Date("2026-10-07T09:00:00Z");
const REDIRECT = "http://localhost:3000/auth/microsoft/callback";

const studio: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone\nStudio Legale Sapone",
};

// ---------------------------------------------------------------------------
// Servizi Microsoft finti
// ---------------------------------------------------------------------------

class MemoryTokenStore implements TokenStore {
  tokens: StoredTokens | null = null;
  saves = 0;
  async load(): Promise<StoredTokens | null> {
    return this.tokens === null ? null : structuredClone(this.tokens);
  }
  async save(tokens: StoredTokens): Promise<void> {
    this.saves += 1;
    this.tokens = structuredClone(tokens);
  }
  async clear(): Promise<void> {
    this.tokens = null;
  }
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error;

/** fetch finto: registra le richieste e risponde con la funzione indicata. */
function fakeFetch(handler: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string> | undefined) ?? {})),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const reply = handler(call);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const body = reply.json === undefined ? null : JSON.stringify(reply.json);
    return new Response(status === 202 || status === 204 ? null : body, {
      status,
      headers: { "Content-Type": "application/json", ...reply.headers },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function tokenParams(call: Call): URLSearchParams {
  return new URLSearchParams(call.body ?? "");
}

function connectedStore(overrides: Partial<StoredTokens> = {}): MemoryTokenStore {
  const store = new MemoryTokenStore();
  store.tokens = {
    accessToken: "AT-valido",
    refreshToken: "RT-1",
    expiresAt: NOW.getTime() + 3_600_000,
    account: { name: "Vincenzo Sapone", username: "avvocato@studio.example" },
    connectedAt: NOW.toISOString(),
    ...overrides,
  };
  return store;
}

function makeAuth(store: TokenStore, fetchImpl: typeof fetch, now: () => Date = () => NOW): Microsoft365Auth {
  return new Microsoft365Auth({
    tenantId: "tenant-studio",
    clientId: "client-seguito",
    clientSecret: "segreto-applicazione",
    redirectUri: REDIRECT,
    scopes: microsoft365Scopes("bozza"),
    tokenStore: store,
    fetchImpl,
    now,
  });
}

// ---------------------------------------------------------------------------
// Accesso
// ---------------------------------------------------------------------------

describe("Microsoft365Auth", () => {
  it("collega l'account con codice di autorizzazione e PKCE e salva i token", async () => {
    const store = new MemoryTokenStore();
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url.endsWith("/oauth2/v2.0/token")) {
        return { json: { access_token: "AT-1", refresh_token: "RT-1", expires_in: 3599, token_type: "Bearer" } };
      }
      return {
        json: { displayName: "Vincenzo Sapone", mail: "avvocato@studio.example", userPrincipalName: "vsapone@studio.onmicrosoft.com" },
      };
    });
    const auth = makeAuth(store, fetchImpl);

    const url = new URL(auth.authorizationUrl());
    expect(`${url.origin}${url.pathname}`).toBe("https://login.microsoftonline.com/tenant-studio/oauth2/v2.0/authorize");
    const params = url.searchParams;
    expect(params.get("client_id")).toBe("client-seguito");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe(REDIRECT);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")?.split(" ").sort()).toEqual(
      ["Calendars.ReadWrite", "Mail.ReadWrite", "User.Read", "offline_access"].sort(),
    );
    expect(params.get("client_secret")).toBeNull();
    const state = params.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(40);

    await expect(auth.complete(new URLSearchParams({ code: "CODICE", state }))).resolves.toBe("avvocato@studio.example");

    const exchange = tokenParams(calls[0] as Call);
    expect(calls[0]?.method).toBe("POST");
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("CODICE");
    expect(exchange.get("redirect_uri")).toBe(REDIRECT);
    expect(exchange.get("client_secret")).toBe("segreto-applicazione");
    const verifier = exchange.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(params.get("code_challenge"));
    expect(calls[1]?.url).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\?/);
    expect(calls[1]?.headers.Authorization).toBe("Bearer AT-1");

    expect(store.tokens).toMatchObject({
      accessToken: "AT-1",
      refreshToken: "RT-1",
      expiresAt: NOW.getTime() + 3_599_000,
      account: { name: "Vincenzo Sapone", username: "avvocato@studio.example" },
    });
    expect(await auth.status()).toEqual({ connected: true, account: "avvocato@studio.example" });

    // Lo stesso ritorno non vale due volte.
    await expect(auth.complete(new URLSearchParams({ code: "CODICE", state }))).rejects.toMatchObject({
      name: "Microsoft365AuthError",
      reason: "scaduto",
    });
  });

  it("rifiuta ritorni annullati, con stato sconosciuto o scaduto", async () => {
    let now = NOW;
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const auth = makeAuth(new MemoryTokenStore(), fetchImpl, () => now);

    const cancelled = new URL(auth.authorizationUrl()).searchParams.get("state") ?? "";
    await expect(
      auth.complete(new URLSearchParams({ error: "access_denied", error_description: "AADSTS65004", state: cancelled })),
    ).rejects.toMatchObject({ reason: "annullato" });
    await expect(auth.complete(new URLSearchParams({ code: "C", state: "inventato" }))).rejects.toMatchObject({
      reason: "scaduto",
    });
    const late = new URL(auth.authorizationUrl()).searchParams.get("state") ?? "";
    now = new Date(NOW.getTime() + 11 * 60_000);
    await expect(auth.complete(new URLSearchParams({ code: "C", state: late }))).rejects.toMatchObject({
      reason: "scaduto",
    });
    expect(calls).toHaveLength(0);
  });

  it("traduce gli errori dell'endpoint dei token senza riportarne il testo", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 401,
      json: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." },
    }));
    const auth = makeAuth(new MemoryTokenStore(), fetchImpl);
    const state = new URL(auth.authorizationUrl()).searchParams.get("state") ?? "";
    const error = await auth.complete(new URLSearchParams({ code: "C", state })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Microsoft365AuthError);
    expect(error).toMatchObject({ reason: "configurazione" });
    expect((error as Error).message).toMatch(/SEGUITO_M365_CLIENT_SECRET/);
    expect((error as Error).message).not.toMatch(/AADSTS/);
  });

  it("rinnova il token in scadenza una sola volta anche con richieste concorrenti", async () => {
    const store = connectedStore({ expiresAt: NOW.getTime() + 60_000 });
    const { calls, fetchImpl } = fakeFetch(() => ({
      json: { access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 },
    }));
    const auth = makeAuth(store, fetchImpl);

    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(tokens).toEqual(["AT-2", "AT-2", "AT-2"]);
    expect(calls).toHaveLength(1);
    const refresh = tokenParams(calls[0] as Call);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("RT-1");
    expect(refresh.get("scope")).toContain("offline_access");
    expect(store.tokens).toMatchObject({ accessToken: "AT-2", refreshToken: "RT-2", expiresAt: NOW.getTime() + 3_600_000 });
    expect(store.tokens?.account.username).toBe("avvocato@studio.example");

    // Token ancora valido: nessuna richiesta.
    await expect(auth.accessToken()).resolves.toBe("AT-2");
    expect(calls).toHaveLength(1);
  });

  it("con il rinnovo revocato scollega l'account e chiede di ricollegarlo", async () => {
    const store = connectedStore({ expiresAt: NOW.getTime() - 1000 });
    const { fetchImpl } = fakeFetch(() => ({ status: 400, json: { error: "invalid_grant", error_codes: [70008] } }));
    const auth = makeAuth(store, fetchImpl);
    await expect(auth.accessToken()).rejects.toMatchObject({ name: "Microsoft365AuthError", reason: "scaduto" });
    expect(store.tokens).toBeNull();
    expect(await auth.status()).toEqual({ connected: false, account: null });
    await expect(auth.accessToken()).rejects.toThrow(/non è collegato/);
  });

  it("conserva i token in un file leggibile solo dall'utente", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seguito-m365-"));
    try {
      const file = join(dir, "sub", "microsoft365.json");
      const store = new FileTokenStore(file);
      expect(await store.load()).toBeNull();
      const tokens = (connectedStore().tokens as StoredTokens);
      await store.save(tokens);
      expect(await store.load()).toEqual(tokens);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await store.clear();
      expect(await store.load()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createMicrosoft365", () => {
  const base: Microsoft365Config = {
    configured: true,
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "segreto",
    redirectUri: REDIRECT,
    tokensFile: "/tmp/inesistente/microsoft365.json",
    transcriptDelivery: "bozza",
  };

  it("non crea nulla senza configurazione completa e rifiuta un indirizzo di ritorno non valido", () => {
    expect(createMicrosoft365({ ...base, configured: false, clientSecret: null })).toBeNull();
    expect(() => createMicrosoft365({ ...base, redirectUri: "non un indirizzo" })).toThrow(/SEGUITO_M365_REDIRECT_URI/);
    expect(createMicrosoft365(base)?.office.name).toBe("microsoft365");
  });

  it("chiede Mail.Send solo se la trascrizione va inviata", () => {
    expect(microsoft365Scopes("bozza")).not.toContain("Mail.Send");
    expect(microsoft365Scopes("invio")).toContain("Mail.Send");
  });
});

// ---------------------------------------------------------------------------
// Client Graph
// ---------------------------------------------------------------------------

describe("GraphClient", () => {
  it("rispetta Retry-After su 429 e rinnova il token una volta su 401", async () => {
    const replies: Reply[] = [
      { status: 429, headers: { "Retry-After": "2" }, json: { error: { code: "TooManyRequests" } } },
      { status: 401, json: { error: { code: "InvalidAuthenticationToken" } } },
      { status: 201, json: { id: "evento-1" } },
    ];
    const { calls, fetchImpl } = fakeFetch(() => replies.shift() ?? { status: 500 });
    const sleep = vi.fn(async () => undefined);
    const accessToken = vi.fn(async (force?: boolean) => (force ? "AT-nuovo" : "AT-vecchio"));
    const graph = new GraphClient({ accessToken, fetchImpl, sleep });

    await expect(graph.request("POST", "/me/events", { subject: "x" })).resolves.toEqual({ id: "evento-1" });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer AT-vecchio", "Bearer AT-vecchio", "Bearer AT-nuovo"]);
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("non ripete le creazioni dopo un timeout del gateway, ma ripete le letture", async () => {
    const post = fakeFetch(() => ({ status: 504 }));
    const sleep = vi.fn(async () => undefined);
    const graphPost = new GraphClient({ accessToken: async () => "AT", fetchImpl: post.fetchImpl, sleep });
    await expect(graphPost.request("POST", "/me/messages", {})).rejects.toBeInstanceOf(ConnectorError);
    expect(post.calls).toHaveLength(1);

    const replies: Reply[] = [{ status: 504 }, { json: { value: [] } }];
    const get = fakeFetch(() => replies.shift() ?? { status: 500 });
    const graphGet = new GraphClient({ accessToken: async () => "AT", fetchImpl: get.fetchImpl, sleep });
    await expect(graphGet.request("GET", "/me")).resolves.toEqual({ value: [] });
    expect(get.calls).toHaveLength(2);
  });

  it("traduce gli errori in italiano senza riportare i messaggi del server", async () => {
    const forbidden = fakeFetch(() => ({
      status: 403,
      json: { error: { code: "ErrorAccessDenied", message: "Access is denied for mario.rossi@example.com" } },
    }));
    const graph = new GraphClient({ accessToken: async () => "AT", fetchImpl: forbidden.fetchImpl, sleep: async () => {} });
    const error = await graph.request("POST", "/me/events", {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as Error).message).toMatch(/Calendars\.ReadWrite/);
    expect((error as Error).message).not.toMatch(/mario/);

    const invalid = fakeFetch(() => ({ status: 400, json: { error: { code: "ErrorInvalidRequest", message: "dati" } } }));
    const graph2 = new GraphClient({ accessToken: async () => "AT", fetchImpl: invalid.fetchImpl, sleep: async () => {} });
    await expect(graph2.request("POST", "/me/messages", {})).rejects.toThrow(/HTTP 400, ErrorInvalidRequest/);

    const offline = fakeFetch(() => new TypeError("fetch failed"));
    const graph3 = new GraphClient({ accessToken: async () => "AT", fetchImpl: offline.fetchImpl, sleep: async () => {} });
    await expect(graph3.request("GET", "/me")).rejects.toThrow(/non risponde/);
    expect(offline.calls).toHaveLength(4);

    const expired = fakeFetch(() => ({ status: 401 }));
    const onAuthFailure = vi.fn(async () => undefined);
    const graph4 = new GraphClient({
      accessToken: async () => "AT",
      fetchImpl: expired.fetchImpl,
      sleep: async () => {},
      onAuthFailure,
    });
    await expect(graph4.request("GET", "/me")).rejects.toBeInstanceOf(Microsoft365AuthError);
    expect(expired.calls).toHaveLength(2);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("per una creazione senza conferma avvisa che potrebbe essere già avvenuta, senza ripeterla", async () => {
    for (const reply of [new TypeError("fetch failed"), { status: 504 }, { status: 502 }] as Reply[]) {
      const { calls, fetchImpl } = fakeFetch(() => reply);
      const graph = new GraphClient({ accessToken: async () => "AT", fetchImpl, sleep: async () => {} });
      const error = await graph.request("POST", "/me/messages", {}).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as Error).message).toMatch(/potrebbe essere già stata eseguita.*prima di approvare di nuovo/);
      expect(calls).toHaveLength(1);
    }
  });

  it("senza Retry-After attende sempre di più tra un tentativo e l'altro", async () => {
    for (const method of ["GET", "POST"] as const) {
      const { calls, fetchImpl } = fakeFetch(() => ({ status: 503, headers: { "Retry-After": "" } }));
      const sleep = vi.fn(async (_ms: number) => undefined);
      const graph = new GraphClient({ accessToken: async () => "AT", fetchImpl, sleep });
      await expect(graph.request(method, "/me/events", method === "POST" ? {} : undefined)).rejects.toThrow(/sovraccarico/);
      expect(calls).toHaveLength(4);
      expect(sleep.mock.calls.map((args) => args[0])).toEqual([1000, 2000, 4000]);
    }
  });

  it("rinnova il token una sola volta anche se seguono altri tentativi, e chiede id immutabili", async () => {
    const replies: Reply[] = [
      { status: 401 },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429 },
      { status: 201, json: { id: "x" } },
    ];
    const { calls, fetchImpl } = fakeFetch(() => replies.shift() ?? { status: 500 });
    const accessToken = vi.fn(async (_force?: boolean) => "AT");
    const graph = new GraphClient({ accessToken, fetchImpl, sleep: async () => {} });
    await graph.request("POST", "/me/events", {});
    expect(accessToken.mock.calls.map((args) => args[0])).toEqual([false, true, false, false]);
    expect(calls.every((c) => c.headers.Prefer === 'IdType="ImmutableId"')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ufficio Microsoft 365
// ---------------------------------------------------------------------------

function graphRecorder(responses: Partial<Record<string, unknown>> = {}) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let counter = 0;
  const graph = {
    async request(method: string, path: string, body?: unknown) {
      requests.push({ method, path, body: (body ?? {}) as Record<string, unknown> });
      if (path === "/me/sendMail") return null;
      counter += 1;
      return (
        responses[path] ?? {
          id: `id-${counter}`,
          webLink: `https://outlook.office365.com/owa/?ItemID=id-${counter}`,
        }
      );
    },
  } as unknown as GraphClient;
  return { graph, requests };
}

function target(overrides: { studioEmail?: string } = {}): OfficeTarget {
  return {
    ctx: {
      proposal: { id: "plaud:rossi-0001" },
      recording: {},
      studio: { ...studio, ...overrides },
      outboxDir: "/inesistente",
      caseManagement: {},
      now: NOW,
      approvedActionIds: new Set(["a1"]),
    },
    action: { id: "a1" },
  } as unknown as OfficeTarget;
}

const appointment: CalendarEventSpec = {
  label: "Evento: Incontro in studio",
  stem: "Incontro in studio",
  title: "Incontro in studio",
  description: "Partecipanti: Mario Rossi",
  location: "Studio Legale Sapone",
  start: "2026-10-15T10:00",
  allDayDate: null,
  durationMinutes: 90,
  remindersMinutesBefore: [60, 1440],
  busy: true,
};

describe("Microsoft365Office", () => {
  it("crea l'evento con orario in UTC, promemoria e identificativo stabile", async () => {
    const { graph, requests } = graphRecorder();
    const office = new Microsoft365Office({ graph, transcriptDelivery: "bozza" });
    const artifact = await office.createEvent(appointment, target());
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/me/events");
    expect(requests[0]?.body).toMatchObject({
      subject: "Incontro in studio",
      body: { contentType: "text", content: "Partecipanti: Mario Rossi" },
      start: { dateTime: "2026-10-15T08:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-15T09:30:00", timeZone: "UTC" },
      isAllDay: false,
      location: { displayName: "Studio Legale Sapone" },
      showAs: "busy",
      isReminderOn: true,
      reminderMinutesBeforeStart: 60,
      categories: ["Seguito"],
    });
    expect(artifact).toEqual({
      kind: "evento_calendario",
      label: "Evento: Incontro in studio",
      path: null,
      ref: "id-1",
      url: "https://outlook.office365.com/owa/?ItemID=id-1",
    });

    await office.createEvent(appointment, target());
    await office.createEvent({ ...appointment, start: "2026-10-16T10:00" }, target());
    const ids = requests.map((r) => r.body.transactionId);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("crea le scadenze sull'intera giornata nel fuso dello studio, senza occupare l'agenda", async () => {
    const { graph, requests } = graphRecorder();
    const office = new Microsoft365Office({ graph, transcriptDelivery: "bozza" });
    await office.createEvent(
      {
        ...appointment,
        title: "Scadenza: Termine per l'opposizione (da verificare)",
        location: null,
        start: null,
        allDayDate: "2026-12-31",
        remindersMinutesBefore: [10080, 1440],
        busy: false,
      },
      target(),
    );
    const body = requests[0]?.body ?? {};
    expect(body).toMatchObject({
      subject: "Scadenza: Termine per l'opposizione (da verificare)",
      start: { dateTime: "2026-12-31T00:00:00", timeZone: "W. Europe Standard Time" },
      end: { dateTime: "2027-01-01T00:00:00", timeZone: "W. Europe Standard Time" },
      isAllDay: true,
      showAs: "free",
      reminderMinutesBeforeStart: 10080,
    });
    expect(body).not.toHaveProperty("location");
  });

  it("crea le bozze nella casella con destinatari e allegati, senza inviarle", async () => {
    const { graph, requests } = graphRecorder();
    const office = new Microsoft365Office({ graph, transcriptDelivery: "bozza" });
    const spec: MessageSpec = {
      label: "Bozza email: Documenti",
      to: [{ name: "Mario Rossi", email: "mario.rossi@example.com" }, { name: null, email: "altro@example.com" }],
      subject: "Documenti",
      text: "Gentile Sig. Rossi,\n\n…",
      attachments: [{ filename: "trascrizione.txt", contentType: "text/plain; charset=utf-8", content: "Testo è" }],
    };
    const artifact = await office.createDraft(spec);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/me/messages");
    expect(requests[0]?.body).toEqual({
      subject: "Documenti",
      body: { contentType: "text", content: "Gentile Sig. Rossi,\n\n…" },
      toRecipients: [
        { emailAddress: { address: "mario.rossi@example.com", name: "Mario Rossi" } },
        { emailAddress: { address: "altro@example.com" } },
      ],
      attachments: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "trascrizione.txt",
          contentType: "text/plain; charset=utf-8",
          contentBytes: Buffer.from("Testo è", "utf8").toString("base64"),
        },
      ],
    });
    expect(artifact).toMatchObject({ kind: "bozza_email", ref: "id-1", url: expect.stringMatching(/^https:\/\//) });
  });

  it("omette gli allegati oltre 3 MB e ignora collegamenti non https", async () => {
    const { graph, requests } = graphRecorder({ "/me/messages": { id: "m1", webLink: "javascript:alert(1)" } });
    const office = new Microsoft365Office({ graph, transcriptDelivery: "bozza" });
    // Allegato entro 3 MB ma, con il testo, oltre il limite dell'intera richiesta.
    const longText = "y".repeat(2 * 1024 * 1024);
    await office.createDraft({
      label: "Bozza email: Trascrizione",
      to: [],
      subject: "Trascrizione",
      text: longText,
      attachments: [{ filename: "trascrizione.txt", contentType: "text/plain", content: longText }],
    });
    expect(requests[0]?.body).not.toHaveProperty("attachments");
    requests.length = 0;
    const big = "x".repeat(3 * 1024 * 1024);
    const artifact = await office.createDraft({
      label: "Bozza email: Trascrizione",
      to: [],
      subject: "Trascrizione",
      text: "Testo",
      attachments: [{ filename: "trascrizione.txt", contentType: "text/plain", content: big }],
    });
    expect(requests[0]?.body).not.toHaveProperty("attachments");
    expect(String((requests[0]?.body.body as { content: string }).content)).toMatch(/Allegati omessi/);
    expect(artifact.url).toBeNull();
  });

  it("invia la trascrizione solo se configurato e solo alla casella dello studio", async () => {
    const spec: MessageSpec = {
      label: "Bozza email: Trascrizione",
      to: [{ name: null, email: "Segreteria@Studio.example" }],
      subject: "Trascrizione",
      text: "Testo",
    };
    const draftOnly = graphRecorder();
    const delivered = await new Microsoft365Office({ graph: draftOnly.graph, transcriptDelivery: "bozza" }).deliverToStudio(
      spec,
      target(),
    );
    expect(delivered.sent).toBe(false);
    expect(draftOnly.requests.map((r) => r.path)).toEqual(["/me/messages"]);

    const sending = graphRecorder();
    const office = new Microsoft365Office({ graph: sending.graph, transcriptDelivery: "invio" });
    const sent = await office.deliverToStudio(spec, target());
    expect(sent).toMatchObject({ sent: true, artifact: { kind: "email_inviata" } });
    expect(sending.requests[0]?.path).toBe("/me/sendMail");
    expect(sending.requests[0]?.body).toMatchObject({ saveToSentItems: true, message: { subject: "Trascrizione" } });

    // Destinatario diverso dalla casella dello studio (o più destinatari): resta una bozza.
    for (const to of [[{ name: null, email: "mario.rossi@example.com" }], [...spec.to, { name: null, email: "x@example.com" }]]) {
      const guarded = graphRecorder();
      const result = await new Microsoft365Office({ graph: guarded.graph, transcriptDelivery: "invio" }).deliverToStudio(
        { ...spec, to },
        target(),
      );
      expect(result.sent).toBe(false);
      expect(guarded.requests.map((r) => r.path)).toEqual(["/me/messages"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Approvazione con Microsoft 365, sulle telefonate di esempio
// ---------------------------------------------------------------------------

describe("approvazione con Microsoft 365", () => {
  let dir: string;
  let caseManagement: JsonCaseManagement;
  let rossi: { proposal: Proposal; recording: Recording };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seguito-m365-flow-"));
    const caseFile = join(dir, "gestionale.json");
    await copyFile(join(FIXTURES, "gestionale.json"), caseFile);
    caseManagement = new JsonCaseManagement(caseFile, { timeZone: "Europe/Rome" });
    const source = new FileSource({ path: join(FIXTURES, "plaud"), now: () => NOW });
    const recording = await source.fetchRecording("demo-rossi-decreto-ingiuntivo");
    const deps = {
      store: new JsonFileStore(join(dir, "data")),
      extractor: new FixtureExtractor({ dir: join(FIXTURES, "extractions") }),
      caseManagement,
      studio,
    };
    const { proposal } = await processRecording(recording, deps, {
      now: new Date(Date.parse(recording.startedAt) + 30 * 60_000),
    });
    rossi = { proposal, recording };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function approve(executors: ReturnType<typeof defaultExecutors>): Promise<Proposal> {
    return approveProposal({
      proposal: rossi.proposal,
      request: { actionIds: rossi.proposal.actions.filter((a) => a.preselected).map((a) => a.id) },
      recording: rossi.recording,
      studio,
      outboxDir: join(dir, "outbox"),
      caseManagement,
      now: NOW,
      executors,
    });
  }

  it("crea eventi e bozze in Outlook, note nel gestionale e nessun file nell'outbox", async () => {
    const { graph, requests } = graphRecorder();
    const approved = await approve(defaultExecutors(new Microsoft365Office({ graph, transcriptDelivery: "bozza" })));

    expect(approved.status).toBe("eseguita");
    const byType = new Map(
      approved.executions.map((e) => [rossi.proposal.actions.find((a) => a.id === e.actionId)?.payload.type, e]),
    );
    expect(byType.get("appuntamento")?.message).toBe("Evento del calendario Outlook creato: giovedì 15 ottobre 2026 alle ore 10:00.");
    expect(byType.get("scadenza")?.message).toMatch(/^Scadenza inserita nel calendario Outlook: mercoledì 11 novembre 2026\./);
    expect(byType.get("email")?.message).toBe("Bozza creata in Outlook.");
    expect(byType.get("invio_trascrizione")?.message).toBe("Bozza con la trascrizione per segreteria@studio.example creata in Outlook.");
    expect(byType.get("incarico")?.artifacts[0]?.kind).toBe("gestionale");

    const paths = requests.map((r) => r.path).sort();
    expect(paths).toEqual(["/me/events", "/me/events", "/me/messages", "/me/messages"]);
    const deadline = requests.find((r) => r.path === "/me/events" && r.body.isAllDay === true);
    expect(deadline?.body.subject).toMatch(/\(da verificare\)$/);
    expect(deadline?.body.start).toEqual({ dateTime: "2026-11-11T00:00:00", timeZone: "W. Europe Standard Time" });
    const email = requests.find((r) => r.path === "/me/messages" && !String(r.body.subject).startsWith("Trascrizione"));
    expect(email?.body.toRecipients).toEqual([{ emailAddress: { address: "mario.rossi@example.com", name: "Mario Rossi" } }]);
    expect(String((email?.body.body as { content: string }).content)).toMatch(/Avv\. Vincenzo Sapone\nStudio Legale Sapone$/);
    await expect(stat(join(dir, "outbox"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("senza collegamento le azioni di calendario ed email restano da eseguire, il gestionale procede", async () => {
    const microsoft = createMicrosoft365(
      {
        configured: true,
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "segreto",
        redirectUri: REDIRECT,
        tokensFile: join(dir, "microsoft365.json"),
        transcriptDelivery: "bozza",
      },
      { fetchImpl: fakeFetch(() => ({ status: 500 })).fetchImpl, tokenStore: new MemoryTokenStore() },
    );
    if (microsoft === null) throw new Error("Microsoft 365 non creato");
    const approved = await approve(defaultExecutors(microsoft.office));

    expect(approved.status).toBe("eseguita_parzialmente");
    for (const execution of approved.executions) {
      const type = rossi.proposal.actions.find((a) => a.id === execution.actionId)?.payload.type;
      if (type === "appuntamento" || type === "scadenza" || type === "email" || type === "invio_trascrizione") {
        expect(execution.status, type).toBe("errore");
        expect(execution.message).toMatch(/Microsoft 365 non è collegato/);
      } else {
        expect(execution.status, type).toBe("ok");
      }
    }
    const notes = JSON.parse(await readFile(join(dir, "gestionale.json"), "utf8")) as { matters: unknown[] };
    expect(notes.matters.length).toBeGreaterThan(0);
  });
});
