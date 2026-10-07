/**
 * Comandi di Seguito (eseguiti con tsx): demo, serve, poll, ingest.
 * Messaggi in italiano; codice di uscita 1 in caso di errore.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "./config.js";
import type { Recording } from "./domain/types.js";
import { JsonCaseManagement } from "./enrich/json-case-management.js";
import { ClaudeExtractor } from "./extract/claude-extractor.js";
import type { Extractor } from "./extract/extractor.js";
import { FixtureExtractor } from "./extract/fixture-extractor.js";
import {
  approveStoredProposal,
  discardStoredProposal,
  processRecording,
  syncSource,
  type PipelineDeps,
  type StoredProposalDeps,
  type SyncResult,
} from "./pipeline.js";
import { createAppServer, type AppServices } from "./server/app.js";
import { FileSource } from "./sources/file-source.js";
import { PlaudApiSource } from "./sources/plaud-api.js";
import type { RecordingSource } from "./sources/source.js";
import { JsonFileStore, writeFileAtomic } from "./store/json-store.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_RECORDINGS = join(ROOT, "fixtures", "plaud");
const FIXTURE_EXTRACTIONS = join(ROOT, "fixtures", "extractions");
const FIXTURE_CASE_MANAGEMENT = join(ROOT, "fixtures", "gestionale.json");
/** Nella demo con analisi di esempio l'analisi avviene 30 minuti dopo l'inizio della chiamata. */
const DEMO_ANALYSIS_DELAY_MS = 30 * 60 * 1000;
/** Link di prenotazione fittizio delle analisi di esempio. */
const DEMO_BOOKING_LINK = "https://prenota.studio.example/avv-sapone";
/** Nessun limite al numero di file importati o di registrazioni della demo. */
const ALL = Number.MAX_SAFE_INTEGER;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

const USAGE = `Seguito: dalla registrazione della chiamata alle azioni dello studio.

Uso:
  npm run demo [-- --live]              Demo con tre telefonate di esempio (cartelle separate
                                        data/demo e outbox/demo). Con --live le analizza Claude.
  npm run serve                         Avvia l'interfaccia di approvazione sui dati reali.
  npm run poll [-- --watch <minuti>] [--retry-failed]
                                        Scarica dal Plaud e analizza le registrazioni nuove;
                                        con --watch ripete il controllo ogni <minuti> (minimo 1);
                                        con --retry-failed ripete subito le analisi non riuscite.
  npm run ingest -- <percorso> [--fixture]
                                        Analizza un file o una cartella di trascrizioni esportate;
                                        con --fixture usa le analisi pronte in fixtures/extractions.
  npx tsx src/cli.ts help               Mostra questo aiuto.

Configurazione: copiare .env.example in .env e completare i valori (vedi README.md).`;

/** Errore da mostrare all'utente così com'è, senza dettagli tecnici. */
class CliError extends Error {
  override name = "CliError";
}

type OptionKind = "boolean" | "string";

interface ParsedArgs {
  /** Opzioni senza valore presenti, es. "live". */
  flags: Set<string>;
  /** Opzioni con valore, es. "watch" -> "5". */
  values: Map<string, string>;
  positionals: string[];
}

/** Codice di uscita, oppure null se il comando resta attivo (server, --watch). */
type CommandResult = number | null;

async function main(argv: string[]): Promise<CommandResult> {
  const [command, ...args] = argv;
  switch (command) {
    case "demo":
      return demo(args);
    case "serve":
      return serve(args);
    case "poll":
      return poll(args);
    case "ingest":
      return ingest(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Comando non riconosciuto: «${command}».\n`);
      console.error(USAGE);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Comandi
// ---------------------------------------------------------------------------

async function demo(args: string[]): Promise<CommandResult> {
  const { flags } = parseArgs("demo", args, { live: "boolean" }, 0);
  const config = demoConfig(loadConfig());
  const live = flags.has("live");
  const extractor = live ? claudeExtractor(config, "npm run demo -- --live") : fixtureExtractor();
  const dataDir = join(config.dataDir, "demo");
  const outboxDir = join(config.outboxDir, "demo");
  const caseManagementFile = join(dataDir, "gestionale.json");
  await ensureDemoCaseManagement(caseManagementFile);

  const deps = pipelineDeps(config, dataDir, caseManagementFile, extractor);
  const source = new FileSource({ path: FIXTURE_RECORDINGS, timezone: config.studio.timezone });
  const load = (): Promise<SyncResult> => processDemoRecordings(source, deps, live);

  console.log(live ? "Analisi delle telefonate di esempio con Claude…" : "Caricamento delle telefonate di esempio…");
  const result = await load();
  printSummary(result);
  if ((await deps.store.listProposals()).length === 0) {
    throw new CliError("Nessuna proposta disponibile per la demo: correggere gli errori indicati e riprovare.");
  }
  console.log(`Dati della demo: ${dataDir}\nFile generati: ${outboxDir}`);
  await startServer(config, {
    ...storedProposalServices({ ...deps, outboxDir }, config),
    sync: load,
  });
  return null;
}

async function serve(args: string[]): Promise<CommandResult> {
  parseArgs("serve", args, {}, 0);
  const config = loadConfig();
  const stored: StoredProposalDeps = {
    store: new JsonFileStore(config.dataDir),
    caseManagement: caseManagementFor(config, config.caseManagementFile),
    studio: config.studio,
    outboxDir: config.outboxDir,
  };
  const services = storedProposalServices(stored, config);
  const plaudLinked = existsSync(config.plaud.tokensPath);
  if (plaudLinked && config.claude.apiKeyPresent) {
    const deps: PipelineDeps = { ...stored, extractor: claudeExtractor(config, "npm run serve") };
    const source = PlaudApiSource.fromConfig(config);
    services.sync = () => syncWithoutThrowing(source, deps);
  } else {
    console.log(
      `Il pulsante «Aggiorna» ricarica solo l'elenco: per cercare le registrazioni nuove servono ${missingForSync(
        plaudLinked,
        config.claude.apiKeyPresent,
      )}.`,
    );
  }
  await startServer(config, services);
  return null;
}

async function poll(args: string[]): Promise<CommandResult> {
  const { flags, values } = parseArgs("poll", args, { watch: "string", "retry-failed": "boolean" }, 0);
  const watch = values.get("watch");
  const minutes = watch === undefined ? null : parseMinutes(watch);
  const config = loadConfig();
  const extractor = claudeExtractor(config, "npm run poll");
  requirePlaudLogin(config);
  const deps = pipelineDeps(config, config.dataDir, config.caseManagementFile, extractor);
  const source = PlaudApiSource.fromConfig(config);
  // Con --watch le analisi non riuscite si ripetono subito solo al primo controllo.
  let retryFailed = flags.has("retry-failed");
  const runOnce = async (): Promise<SyncResult> => {
    console.log(`[${timestamp(config)}] Controllo delle registrazioni nel Plaud…`);
    const result = await syncSource(source, deps, { retryFailed, log: (msg) => console.log(`  ${msg}`) });
    retryFailed = false;
    printSummary(result);
    if (result.postponed > 0) {
      console.log("Per ripetere subito le analisi rinviate o non riuscite: npm run poll -- --retry-failed");
    }
    return result;
  };
  if (minutes === null) {
    return (await runOnce()).errors.length > 0 ? 1 : 0;
  }
  watchLoop(runOnce, minutes);
  return null;
}

async function ingest(args: string[]): Promise<CommandResult> {
  const { flags, positionals } = parseArgs("ingest", args, { fixture: "boolean" }, 1);
  const [path] = positionals;
  if (path === undefined) {
    throw new CliError("Indicare il file o la cartella da importare: npm run ingest -- <percorso> [--fixture]");
  }
  const config = loadConfig();
  const extractor = flags.has("fixture") ? fixtureExtractor() : claudeExtractor(config, "npm run ingest");
  const deps = pipelineDeps(config, config.dataDir, config.caseManagementFile, extractor);
  const source = new FileSource({ path: resolve(path), timezone: config.studio.timezone });
  console.log(`Importazione da ${resolve(path)}…`);
  // Importazione manuale: le analisi non riuscite in precedenza si ripetono sempre.
  const result = await syncSource(source, deps, {
    limit: ALL,
    retryFailed: true,
    log: (msg) => console.log(`  ${msg}`),
  });
  printSummary(result);
  if (result.processed > 0) console.log("Aprire l'interfaccia con «npm run serve» per rivedere le proposte.");
  return result.errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

/** Senza SEGUITO_BOOKING_LINK la demo usa il link fittizio citato nell'email di esempio a Verdi. */
function demoConfig(config: AppConfig): AppConfig {
  return { ...config, studio: { ...config.studio, bookingLink: config.studio.bookingLink ?? DEMO_BOOKING_LINK } };
}

/** Copia il gestionale di esempio nella cartella della demo, se non c'è già. */
async function ensureDemoCaseManagement(file: string): Promise<void> {
  if (existsSync(file)) return;
  await writeFileAtomic(file, await readFile(FIXTURE_CASE_MANAGEMENT, "utf8"));
}

/**
 * Elabora tutte le telefonate di esempio. Una proposta creata con un altro
 * estrattore (analisi di esempio o Claude) e non ancora eseguita viene
 * rigenerata, così la demo mostra sempre l'analisi richiesta.
 */
async function processDemoRecordings(source: FileSource, deps: PipelineDeps, live: boolean): Promise<SyncResult> {
  const result: SyncResult = { processed: 0, skipped: 0, notReady: 0, postponed: 0, errors: [] };
  for (const ref of await source.listRecent({ limit: ALL })) {
    try {
      const recording = await source.fetchRecording(ref.externalId);
      const existing = await deps.store.getProposal(recording.id);
      const force =
        existing !== null && existing.extractor.name !== deps.extractor.name && existing.executions.length === 0;
      const { created } = await processRecording(recording, deps, { now: demoNow(recording, live), force });
      if (created) {
        result.processed++;
        console.log(`  Elaborata: «${recording.title}».`);
      } else {
        result.skipped++;
      }
    } catch (err) {
      const message = `«${ref.title}»: ${errorMessage(err)}`;
      result.errors.push(message);
      console.error(`  Errore – ${message}`);
    }
  }
  return result;
}

/** Con le analisi di esempio l'ora è fissa, così avvisi e preselezioni restano stabili nel tempo. */
function demoNow(recording: Recording, live: boolean): Date {
  return live ? new Date() : new Date(Date.parse(recording.startedAt) + DEMO_ANALYSIS_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Servizi e server
// ---------------------------------------------------------------------------

function pipelineDeps(config: AppConfig, dataDir: string, caseManagementFile: string, extractor: Extractor): PipelineDeps {
  return {
    store: new JsonFileStore(dataDir),
    extractor,
    caseManagement: caseManagementFor(config, caseManagementFile),
    studio: config.studio,
  };
}

function caseManagementFor(config: AppConfig, file: string): JsonCaseManagement {
  return new JsonCaseManagement(file, { timeZone: config.studio.timezone });
}

function storedProposalServices(deps: StoredProposalDeps, config: AppConfig): AppServices {
  const { host, password, allowedHosts } = config.server;
  return {
    store: deps.store,
    studio: deps.studio,
    outboxDir: deps.outboxDir,
    password,
    // Il nome indicato in SEGUITO_HOST è sempre ammesso; indirizzi IP e localhost lo sono comunque.
    allowedHosts: [host, ...allowedHosts],
    approve: (proposalId, request) => approveStoredProposal(proposalId, request, deps),
    discard: (proposalId) => discardStoredProposal(proposalId, deps),
  };
}

/** Per l'interfaccia: gli errori generali (es. login Plaud scaduto) diventano messaggi. */
async function syncWithoutThrowing(source: RecordingSource, deps: PipelineDeps): Promise<SyncResult> {
  try {
    return await syncSource(source, deps, { log: (msg) => console.log(msg) });
  } catch (err) {
    const message = errorMessage(err);
    console.error(`Sincronizzazione non riuscita: ${message}`);
    return { processed: 0, skipped: 0, notReady: 0, postponed: 0, errors: [message] };
  }
}

async function startServer(config: AppConfig, services: AppServices): Promise<void> {
  const { host, port } = config.server;
  if (!LOOPBACK_HOSTS.has(host) && services.password === null) {
    console.error(
      `Attenzione: Seguito è raggiungibile da altri dispositivi (SEGUITO_HOST=${host}) senza password. ` +
        "Impostare SEGUITO_PASSWORD nel file .env.",
    );
  }
  const server = createAppServer(services);
  await listen(server, host, port);
  console.log(`\nSeguito è pronto: ${serverUrl(host, port)}\nPremere Ctrl+C per fermarlo.`);
  const stop = (): void => {
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Indirizzo da aprire nel browser; in ascolto su tutte le interfacce si indica quello locale. */
function serverUrl(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::") {
    return `http://127.0.0.1:${port}/ (in ascolto su tutte le interfacce di rete)`;
  }
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}/`;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => reject(listenError(err, host, port)));
    server.listen(port, host, () => resolvePromise());
  });
}

function listenError(err: NodeJS.ErrnoException, host: string, port: number): Error {
  switch (err.code) {
    case "EADDRINUSE":
      return new CliError(
        `La porta ${port} è già in uso: chiudere l'altra istanza di Seguito oppure impostare un'altra porta con SEGUITO_PORT.`,
      );
    case "EACCES":
      return new CliError(`Permesso negato per la porta ${port}: usare una porta superiore a 1024 (SEGUITO_PORT).`);
    case "EADDRNOTAVAIL":
    case "ENOTFOUND":
      return new CliError(`Indirizzo non disponibile su questo computer: ${host} (SEGUITO_HOST).`);
    default:
      return new CliError(`Impossibile avviare il server su ${host}:${port} (${err.code ?? err.message}).`);
  }
}

// ---------------------------------------------------------------------------
// Controllo periodico
// ---------------------------------------------------------------------------

/** Ripete il controllo ogni `minutes` minuti (dalla fine del precedente) fino a Ctrl+C. */
function watchLoop(runOnce: () => Promise<SyncResult>, minutes: number): void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const cycle = async (): Promise<void> => {
    try {
      await runOnce();
    } catch (err) {
      console.error(`Controllo non riuscito: ${errorMessage(err)}`);
    }
    if (stopped) return;
    console.log(`Prossimo controllo tra ${minutesText(minutes)}. Premere Ctrl+C per terminare.`);
    timer = setTimeout(() => void cycle(), minutes * 60_000);
  };
  process.once("SIGINT", () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    console.log("\nControllo periodico terminato.");
  });
  void cycle();
}

function parseMinutes(value: string): number {
  const minutes = Number(value.replace(",", "."));
  if (value.trim() === "" || !Number.isFinite(minutes) || minutes < 1) {
    throw new CliError(`Valore non valido per --watch: «${value}». Indicare i minuti tra un controllo e l'altro (minimo 1).`);
  }
  return minutes;
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function claudeExtractor(config: AppConfig, command: string): ClaudeExtractor {
  if (!config.claude.apiKeyPresent) {
    throw new CliError(
      `«${command}» richiede la chiave API di Claude: impostare ANTHROPIC_API_KEY nel file .env ` +
        "(copiare .env.example in .env se non esiste) e riprovare.",
    );
  }
  return new ClaudeExtractor({
    model: config.claude.model,
    effort: config.claude.effort,
    maxTokens: config.claude.maxTokens,
  });
}

function fixtureExtractor(): FixtureExtractor {
  return new FixtureExtractor({ dir: FIXTURE_EXTRACTIONS });
}

function requirePlaudLogin(config: AppConfig): void {
  if (existsSync(config.plaud.tokensPath)) return;
  throw new CliError(
    `Seguito non è ancora collegato al Plaud (credenziali non trovate in ${config.plaud.tokensPath}). ` +
      "Eseguire «npx @plaud-ai/cli login» su questo computer e riprovare.",
  );
}

function missingForSync(plaudLinked: boolean, apiKeyPresent: boolean): string {
  const missing = [
    plaudLinked ? null : "il collegamento al Plaud («npx @plaud-ai/cli login»)",
    apiKeyPresent ? null : "la chiave API di Claude (ANTHROPIC_API_KEY)",
  ].filter((m) => m !== null);
  return missing.join(" e ");
}

/**
 * Opzioni nella forma "--nome", "--nome valore" o "--nome=valore"; le opzioni
 * sconosciute e gli argomenti in eccesso sono errori.
 */
function parseArgs(
  command: string,
  args: string[],
  spec: Readonly<Record<string, OptionKind>>,
  maxPositionals: number,
): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) throw new CliError(`Opzione non riconosciuta per «${command}»: ${arg}\n\n${USAGE}`);
    if (kind === "boolean") {
      if (inline !== undefined) throw new CliError(`L'opzione --${name} non accetta valori.`);
      flags.add(name);
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined || value === "") throw new CliError(`Manca il valore dell'opzione --${name}.`);
    values.set(name, value);
  }
  if (positionals.length > maxPositionals) {
    throw new CliError(`Argomenti non previsti per «${command}»: ${positionals.slice(maxPositionals).join(" ")}\n\n${USAGE}`);
  }
  return { flags, values, positionals };
}

function printSummary(result: SyncResult): void {
  const parts = [
    `elaborate ${result.processed}`,
    `già presenti ${result.skipped}`,
    `in attesa di trascrizione ${result.notReady}`,
    `analisi rinviate ${result.postponed}`,
    `errori ${result.errors.length}`,
  ];
  console.log(`Registrazioni: ${parts.join(" · ")}.`);
}

function timestamp(config: AppConfig): string {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: config.studio.timezone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

function minutesText(minutes: number): string {
  return minutes === 1 ? "1 minuto" : `${String(minutes).replace(".", ",")} minuti`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.trim() !== "" ? err.message : "errore imprevisto.";
}

/** Carica ./.env, se presente; le variabili già impostate nell'ambiente prevalgono. */
function loadDotEnv(): void {
  const file = resolve(".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    throw new CliError(`Impossibile leggere il file .env (${errorMessage(err)}).`);
  }
}

async function run(): Promise<void> {
  try {
    loadDotEnv();
    const code = await main(process.argv.slice(2));
    if (code !== null) process.exitCode = code;
  } catch (err) {
    console.error(`Errore: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}

await run();
