import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PlaudApiSource } from "../src/sources/plaud-api.js";
import {
  PlaudApiError,
  PlaudAuthError,
  type PlaudFile,
  PlaudNotReadyError,
  parsePlaudFile,
  parsePlaudTimestamp,
  safeFetchText,
} from "../src/sources/plaud-parse.js";

const API = "https://platform.plaud.example/developer/api";
/** DNS finto: i nomi di prova sono pubblici, salvo quelli indicati. */
const DNS: Record<string, string[]> = {
  "cdn.plaud.example": ["93.184.216.34"],
  localhost: ["127.0.0.1", "::1"],
  "metadata.internal": ["169.254.169.254"],
  "rebind.example": ["93.184.216.35", "10.0.0.7"],
  "mapped.example": ["::ffff:192.168.1.1"],
};
const resolveHost = async (hostname: string): Promise<string[]> => {
  const addresses = DNS[hostname];
  if (addresses === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  return addresses;
};
const REFRESH_URL = "https://platform.plaud.example/developer/api/oauth/third-party/access-token/refresh";
const NOW = new Date("2026-10-07T08:00:00.000Z");

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const transcript = JSON.stringify([
  { start_time: 0, end_time: 4200, speaker: "Speaker 1", content: " Buongiorno avvocato. " },
  { start_time: 4200, end_time: 4800, speaker: "Speaker 2", content: "   " },
  { start_time: 5000, content: "Mi dica pure." },
]);

function detail(overrides: Partial<PlaudFile> = {}): PlaudFile {
  return {
    id: "abc123",
    name: "  Telefonata Rossi  ",
    created_at: "2026-10-07 07:45:00",
    start_at: "2026-10-07 07:30:00",
    duration: 600_000,
    source_list: [{ data_type: "transaction", data_content: transcript }],
    note_list: [],
    ...overrides,
  };
}

/** Elemento dell'elenco con inizio `minutesAgo` minuti prima di `base` (senza fuso, come Plaud). */
function listItem(id: string, base: string, minutesAgo: number, duration: number | null = 60_000) {
  const start = new Date(Date.parse(base) - minutesAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");
  return { id, name: `Registrazione ${id}`, created_at: start, start_at: start, duration };
}

let dir: string;
let tokensPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seguito-plaud-"));
  tokensPath = join(dir, "tokens.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTokens(tokens: Record<string, unknown>): Promise<void> {
  await writeFile(tokensPath, JSON.stringify(tokens));
}

function source(fetchImpl: typeof fetch, region: string | null = null): PlaudApiSource {
  return new PlaudApiSource({
    apiBase: `${API}/`,
    tokensPath,
    refreshUrl: REFRESH_URL,
    region,
    fetchImpl,
    resolveHost,
    now: () => NOW,
  });
}

const validTokens = { access_token: "tok-valid", refresh_token: "ref-1", token_type: "Bearer", expires_at: NOW.getTime() + 3_600_000 };

describe("PlaudApiSource: autenticazione", () => {
  test("rinnova un token in scadenza, lo salva e lo usa", async () => {
    await writeTokens({
      access_token: "tok-old",
      refresh_token: "ref-old",
      token_type: "Bearer",
      expires_at: NOW.getTime() + 30_000,
      client: "cli",
    });
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url === REFRESH_URL) return json({ access_token: "tok-new", expires_in: 7200 });
      return json(detail());
    });
    const src = source(fetchImpl, "eu");
    await Promise.all([src.fetchRecording("abc123"), src.fetchRecording("abc123")]);

    const refreshCalls = calls.filter((c) => c.url === REFRESH_URL);
    expect(refreshCalls).toHaveLength(1);
    const refresh = refreshCalls[0]!;
    expect(refresh.method).toBe("POST");
    expect(refresh.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(refresh.headers.get("accept")).toBe("application/json");
    expect(refresh.body).toBe("refresh_token=ref-old");

    const saved = JSON.parse(await readFile(tokensPath, "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({
      access_token: "tok-new",
      refresh_token: "ref-old",
      token_type: "Bearer",
      expires_at: NOW.getTime() + 7_200_000,
      client: "cli",
    });
    expect((await stat(tokensPath)).mode & 0o777).toBe(0o600);

    const apiCalls = calls.filter((c) => c.url.startsWith(`${API}/open/`));
    expect(apiCalls).toHaveLength(2);
    for (const call of apiCalls) {
      expect(call.url).toBe(`${API}/open/third-party/files/abc123`);
      expect(call.headers.get("authorization")).toBe("Bearer tok-new");
      expect(call.headers.get("accept")).toBe("application/json");
      expect(call.headers.get("x-pld-region")).toBe("eu");
    }
  });

  test("non rinnova un token ancora valido e non invia la regione se assente", async () => {
    await writeTokens(validTokens);
    const { fetchImpl, calls } = fakeFetch(() => json(detail()));
    await source(fetchImpl).fetchRecording("abc123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok-valid");
    expect(calls[0]!.headers.has("x-pld-region")).toBe(false);
  });

  test("HTTP 401 dall'API -> PlaudAuthError", async () => {
    await writeTokens(validTokens);
    const { fetchImpl } = fakeFetch(() => json({ error: "unauthorized" }, 401));
    await expect(source(fetchImpl).listRecent()).rejects.toBeInstanceOf(PlaudAuthError);
  });

  test("HTTP 401 con un token senza scadenza nota: rinnova una volta e ripete la richiesta", async () => {
    await writeTokens({ access_token: "tok-revocato", refresh_token: "ref-1", token_type: "Bearer" });
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url === REFRESH_URL) return json({ access_token: "tok-nuovo" });
      return call.headers.get("authorization") === "Bearer tok-nuovo" ? json(detail()) : json({ error: "unauthorized" }, 401);
    });
    const recording = await source(fetchImpl).fetchRecording("abc123");
    expect(recording.externalId).toBe("abc123");
    expect(calls.map((c) => (c.url === REFRESH_URL ? "rinnovo" : c.headers.get("authorization")))).toEqual([
      "Bearer tok-revocato",
      "rinnovo",
      "Bearer tok-nuovo",
    ]);
    const saved = JSON.parse(await readFile(tokensPath, "utf8")) as Record<string, unknown>;
    expect(saved.access_token).toBe("tok-nuovo");
  });

  test("HTTP 401 anche dopo il rinnovo, o senza refresh token -> PlaudAuthError", async () => {
    await writeTokens(validTokens);
    const rejected = fakeFetch((call) => (call.url === REFRESH_URL ? json({ access_token: "tok-2" }) : json({}, 401)));
    await expect(source(rejected.fetchImpl).listRecent()).rejects.toBeInstanceOf(PlaudAuthError);
    expect(rejected.calls.filter((c) => c.url === REFRESH_URL)).toHaveLength(1);

    await writeTokens({ access_token: "tok-valid" });
    const noRefresh = fakeFetch(() => json({}, 401));
    await expect(source(noRefresh.fetchImpl).listRecent()).rejects.toThrow(/npx @plaud-ai\/cli login/);
    expect(noRefresh.calls).toHaveLength(1);
  });

  test("rinnovo rifiutato -> PlaudAuthError", async () => {
    await writeTokens({ ...validTokens, expires_at: NOW.getTime() - 1000 });
    const { fetchImpl } = fakeFetch(() => json({ error: "invalid_grant" }, 401));
    await expect(source(fetchImpl).listRecent()).rejects.toBeInstanceOf(PlaudAuthError);
  });

  test("file dei token mancante o non valido -> PlaudAuthError con istruzioni di login", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({}));
    await expect(source(fetchImpl).listRecent()).rejects.toThrow(/npx @plaud-ai\/cli login/);
    await writeFile(tokensPath, "{ non è json");
    await expect(source(fetchImpl).listRecent()).rejects.toBeInstanceOf(PlaudAuthError);
    expect(calls).toHaveLength(0);
  });

  test("altri errori HTTP -> PlaudApiError con stato, senza il corpo della risposta", async () => {
    await writeTokens(validTokens);
    const { fetchImpl } = fakeFetch(() => new Response("dati riservati del cliente", { status: 500 }));
    const err = await source(fetchImpl).fetchRecording("abc123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaudApiError);
    expect((err as PlaudApiError).status).toBe(500);
    expect((err as PlaudApiError).message).not.toContain("riservati");
  });
});

describe("PlaudApiSource: elenco", () => {
  test("pagina finché ci sono registrazioni dopo `since`, poi filtra, ordina e limita", async () => {
    await writeTokens(validTokens);
    const pages: Record<string, ReturnType<typeof listItem>[]> = {
      "1": Array.from({ length: 50 }, (_, i) => listItem(`p1-${i}`, "2026-10-06T10:00:00Z", i)),
      "2": [
        ...Array.from({ length: 10 }, (_, i) => listItem(`p2-new-${i}`, "2026-10-02T10:00:00Z", i)),
        ...Array.from({ length: 40 }, (_, i) => listItem(`p2-old-${i}`, "2026-09-20T10:00:00Z", i)),
      ],
      "3": Array.from({ length: 50 }, (_, i) => listItem(`p3-${i}`, "2026-09-10T10:00:00Z", i)),
      "4": Array.from({ length: 50 }, (_, i) => listItem(`p4-${i}`, "2026-09-01T10:00:00Z", i)),
    };
    const { fetchImpl, calls } = fakeFetch((call) => {
      const url = new URL(call.url);
      expect(url.pathname).toBe("/developer/api/open/third-party/files/");
      expect(url.searchParams.get("page_size")).toBe("50");
      const page = url.searchParams.get("page") ?? "";
      return json({ data: pages[page] ?? [], page: Number(page) });
    });

    const refs = await source(fetchImpl).listRecent({ since: new Date("2026-10-01T00:00:00Z"), limit: 55 });

    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(refs).toHaveLength(55);
    expect(refs[0]).toEqual({
      externalId: "p1-0",
      title: "Registrazione p1-0",
      startedAt: "2026-10-06T10:00:00.000Z",
      durationMs: 60_000,
      ready: true,
    });
    expect(refs.at(-1)!.externalId).toBe("p2-new-4");
    const times = refs.map((r) => Date.parse(r.startedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(refs.every((r) => r.startedAt >= "2026-10-01")).toBe(true);
  });

  test("si ferma alla prima pagina incompleta; pronta solo con durata positiva", async () => {
    await writeTokens(validTokens);
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        data: [
          listItem("a", "2026-10-07T07:00:00Z", 0, 0),
          listItem("b", "2026-10-07T07:00:00Z", 5, null),
          listItem("c", "2026-10-07T07:00:00Z", 10, 120_000),
        ],
        page: 1,
      }),
    );
    const refs = await source(fetchImpl).listRecent();
    expect(calls).toHaveLength(1);
    expect(refs.map((r) => [r.externalId, r.ready])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
  });
});

describe("PlaudApiSource: dettaglio", () => {
  test("converte trascrizione inline, titolo, orari UTC e riassunto del template Seguito", async () => {
    await writeTokens(validTokens);
    const file = detail({
      note_list: [
        { data_type: "auto_sum_note", data_title: "Riassunto generico", data_content: "Generico" },
        { data_type: "mark_memo", data_title: "Seguito", data_content: "Promemoria" },
        { data_type: "auto_sum_note", data_tab_name: "Template SEGUITO studio", data_content: "  Sintesi Seguito  " },
      ],
    });
    const { fetchImpl } = fakeFetch(() => json(file));
    const recording = await source(fetchImpl).fetchRecording("abc123");
    expect(recording).toEqual({
      id: "plaud:abc123",
      source: "plaud",
      externalId: "abc123",
      title: "Telefonata Rossi",
      startedAt: "2026-10-07T07:30:00.000Z",
      durationMs: 600_000,
      segments: [
        { index: 0, startMs: 0, endMs: 4200, speaker: "Speaker 1", text: "Buongiorno avvocato." },
        { index: 1, startMs: 5000, endMs: null, speaker: "Parlante", text: "Mi dica pure." },
      ],
      plaudSummary: "Sintesi Seguito",
      fetchedAt: NOW.toISOString(),
    });
  });

  test("scarica i blocchi da data_link senza inviare il token", async () => {
    await writeTokens(validTokens);
    const file = detail({
      name: "   ",
      start_at: null,
      source_list: [{ data_type: "transaction", data_content: "", data_link: "https://cdn.plaud.example/t.json?sig=1" }],
      note_list: [{ data_type: "auto_sum_note", data_title: "Riassunto", data_link: "https://cdn.plaud.example/s.md" }],
    });
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.startsWith("https://cdn.plaud.example/t.json")) return new Response(transcript);
      if (call.url === "https://cdn.plaud.example/s.md") return new Response("Riassunto scaricato");
      return json(file);
    });
    const recording = await source(fetchImpl).fetchRecording("abc123");
    expect(recording.title).toBe("Registrazione senza titolo");
    expect(recording.startedAt).toBe("2026-10-07T07:45:00.000Z");
    expect(recording.segments).toHaveLength(2);
    expect(recording.plaudSummary).toBe("Riassunto scaricato");
    const linkCalls = calls.filter((c) => c.url.startsWith("https://cdn.plaud.example/"));
    expect(linkCalls).toHaveLength(2);
    for (const call of linkCalls) expect(call.headers.has("authorization")).toBe(false);
  });

  test("codifica l'id nell'URL del dettaglio", async () => {
    await writeTokens(validTokens);
    const { fetchImpl, calls } = fakeFetch(() => json(detail({ id: "a/b c" })));
    await source(fetchImpl).fetchRecording("a/b c");
    expect(calls[0]!.url).toBe(`${API}/open/third-party/files/a%2Fb%20c`);
  });
});

describe("parsePlaudFile", () => {
  const inline = (block: { data_content?: string | null }) => Promise.resolve(block.data_content ?? "");

  test("senza trascrizione -> PlaudNotReadyError", async () => {
    await expect(parsePlaudFile(detail({ source_list: [] }), inline, NOW)).rejects.toBeInstanceOf(PlaudNotReadyError);
    await expect(
      parsePlaudFile(detail({ source_list: [{ data_type: "transaction", data_content: "[]" }] }), inline, NOW),
    ).rejects.toBeInstanceOf(PlaudNotReadyError);
    await expect(
      parsePlaudFile(
        detail({ source_list: [{ data_type: "outline", data_content: "Scaletta" }] }),
        inline,
        NOW,
      ),
    ).rejects.toThrow(/non è ancora disponibile/);
  });

  test("ripiega su transaction_polish e sceglie la prima nota se manca il template Seguito", async () => {
    const file = detail({
      source_list: [
        { data_type: "transaction", data_content: "" },
        {
          data_type: "transaction_polish",
          data_content: JSON.stringify([{ start_time: 1000, end_time: 2000, speaker: "", content: "Testo rifinito." }]),
        },
      ],
      note_list: [
        { data_type: "auto_sum_note", data_title: "Primo", data_content: "Primo riassunto" },
        { data_type: "auto_sum_note", data_title: "Secondo", data_content: "Secondo riassunto" },
      ],
    });
    const recording = await parsePlaudFile(file, inline, NOW);
    expect(recording.segments).toEqual([
      { index: 0, startMs: 1000, endMs: 2000, speaker: "Parlante", text: "Testo rifinito." },
    ]);
    expect(recording.plaudSummary).toBe("Primo riassunto");
  });

  test("riassunto assente -> null; trascrizione non riconosciuta -> errore chiaro", async () => {
    expect((await parsePlaudFile(detail(), inline, NOW)).plaudSummary).toBeNull();
    await expect(
      parsePlaudFile(detail({ source_list: [{ data_type: "transaction", data_content: "{oops" }] }), inline, NOW),
    ).rejects.toThrow(/formato riconosciuto/);
  });

  test("data di inizio non interpretabile -> errore chiaro", async () => {
    await expect(parsePlaudFile(detail({ start_at: "ieri", created_at: null }), inline, NOW)).rejects.toThrow(
      /data di inizio valida/,
    );
  });
});

describe("parsePlaudTimestamp", () => {
  test("gli orari senza fuso sono UTC", () => {
    expect(parsePlaudTimestamp("2026-10-07 07:30:00")).toBe("2026-10-07T07:30:00.000Z");
    expect(parsePlaudTimestamp("2026-10-07T07:30:00.250")).toBe("2026-10-07T07:30:00.250Z");
    expect(parsePlaudTimestamp("2026-10-07T07:30:00Z")).toBe("2026-10-07T07:30:00.000Z");
    expect(parsePlaudTimestamp("2026-10-07T09:30:00+02:00")).toBe("2026-10-07T07:30:00.000Z");
    expect(parsePlaudTimestamp("2026-10-07")).toBe("2026-10-07T00:00:00.000Z");
  });

  test("valori assenti o non validi -> null", () => {
    expect(parsePlaudTimestamp(null)).toBeNull();
    expect(parsePlaudTimestamp(undefined)).toBeNull();
    expect(parsePlaudTimestamp("  ")).toBeNull();
    expect(parsePlaudTimestamp("non è una data")).toBeNull();
  });
});

describe("safeFetchText", () => {
  const ok = () => fakeFetch(() => new Response("contenuto"));

  test("rifiuta URL non sicuri senza contattare la rete", async () => {
    const { fetchImpl, calls } = ok();
    for (const url of [
      "http://cdn.plaud.example/t.json",
      "https://utente:segreto@cdn.plaud.example/t.json",
      "https://127.0.0.1/t.json",
      "https://[::1]/t.json",
      "non un url",
    ]) {
      await expect(safeFetchText(url, { fetchImpl, resolveHost })).rejects.toThrow(/Collegamento al contenuto Plaud/);
    }
    expect(calls).toHaveLength(0);
  });

  test("rifiuta i nomi che si risolvono in indirizzi interni, anche dopo un reindirizzamento", async () => {
    const { fetchImpl, calls } = ok();
    for (const url of [
      "https://localhost:8443/admin",
      "https://metadata.internal/latest",
      "https://rebind.example/t.json",
      "https://mapped.example/t.json",
    ]) {
      await expect(safeFetchText(url, { fetchImpl, resolveHost }), url).rejects.toThrow(/indirizzo di rete interno/);
    }
    await expect(safeFetchText("https://sconosciuto.example/t", { fetchImpl, resolveHost })).rejects.toThrow(
      /Impossibile contattare Plaud/,
    );
    expect(calls).toHaveLength(0);

    const redirect = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://localhost/x" } }));
    await expect(
      safeFetchText("https://cdn.plaud.example/a", { fetchImpl: redirect.fetchImpl, resolveHost }),
    ).rejects.toThrow(/indirizzo di rete interno/);
    expect(redirect.calls.map((c) => c.url)).toEqual(["https://cdn.plaud.example/a"]);
  });

  test("segue i reindirizzamenti solo verso destinazioni sicure", async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.url === "https://cdn.plaud.example/a"
        ? new Response(null, { status: 302, headers: { location: "/b" } })
        : call.url === "https://cdn.plaud.example/b"
          ? new Response(null, { status: 302, headers: { location: "https://10.0.0.1/c" } })
          : new Response("non dovrebbe arrivare qui"),
    );
    await expect(safeFetchText("https://cdn.plaud.example/a", { fetchImpl, resolveHost })).rejects.toThrow(/IP diretto/);
  });

  test("applica il limite di dimensione (dichiarata e effettiva)", async () => {
    const declared = fakeFetch(() => new Response("x", { headers: { "content-length": String(30 * 1024 * 1024) } }));
    await expect(safeFetchText("https://cdn.plaud.example/t", { fetchImpl: declared.fetchImpl, resolveHost })).rejects.toThrow(
      /limite/,
    );
    const streamed = fakeFetch(() => new Response("x".repeat(2048)));
    await expect(
      safeFetchText("https://cdn.plaud.example/t", { fetchImpl: streamed.fetchImpl, maxBytes: 1024, resolveHost }),
    ).rejects.toThrow(/limite/);
    const small = fakeFetch(() => new Response("àèì"));
    await expect(safeFetchText("https://cdn.plaud.example/t", { fetchImpl: small.fetchImpl, resolveHost })).resolves.toBe("àèì");
  });

  test("errore HTTP -> PlaudApiError", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("scaduto", { status: 403 }));
    await expect(safeFetchText("https://cdn.plaud.example/t", { fetchImpl, resolveHost })).rejects.toBeInstanceOf(PlaudApiError);
  });
});
