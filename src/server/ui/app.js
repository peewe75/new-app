/**
 * Seguito – interfaccia di approvazione (modulo ES, nessuna dipendenza, nessuna build).
 *
 * Sicurezza: trascrizioni e risultati dell'analisi AI non sono affidabili. Il DOM si
 * costruisce solo con createElement/textContent: mai innerHTML con dati, mai href
 * composti con dati non codificati.
 */

// ---------------------------------------------------------------------------
// Etichette
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  da_revisionare: "Da revisionare",
  eseguita: "Eseguita",
  eseguita_parzialmente: "Eseguita in parte",
  scartata: "Scartata",
};

const STATUS_NOTES = {
  eseguita: {
    tone: "success",
    title: "Proposta eseguita",
    text: "Le azioni approvate sono state eseguite: l'esito e i file generati sono riportati qui sotto.",
  },
  eseguita_parzialmente: {
    tone: "warning",
    title: "Proposta eseguita in parte",
    text: "Alcune azioni non sono andate a buon fine: è possibile correggerle e approvarle di nuovo.",
  },
  scartata: { tone: "neutral", title: "Proposta scartata", text: "Nessuna azione è stata eseguita." },
};

const CONVERSATION_LABELS = {
  telefonata: "Telefonata",
  riunione_in_presenza: "Riunione in presenza",
  videochiamata: "Videochiamata",
  non_determinabile: "Tipo di conversazione non determinato",
};

const SOURCE_LABELS = { plaud: "Plaud Note Pro", file: "File importato" };

const ROLE_LABELS = {
  avvocato_studio: "Avvocato dello studio",
  cliente: "Cliente",
  potenziale_cliente: "Potenziale cliente",
  controparte: "Controparte",
  collega_avvocato: "Collega avvocato",
  consulente: "Consulente",
  altro: "Altro",
  sconosciuto: "Ruolo non determinato",
};

const ACTION_LABELS = {
  appuntamento: "Appuntamento",
  incarico: "Incarico",
  accordo_economico: "Accordo economico",
  scadenza: "Scadenza",
  documenti: "Documenti",
  email: "Email",
  attivita: "Attività",
  invio_trascrizione: "Invio trascrizione",
};

const WARNING_LABELS = {
  COLLEGA_ART38: "Art. 38 CDF",
  EVIDENZA_NON_VERIFICATA: "Citazione da verificare",
  DATA_PASSATA: "Data già passata",
  DATA_MANCANTE: "Data mancante",
  DATA_NON_VALIDA: "Data non valida",
  TERMINE_DA_VERIFICARE: "Termine da verificare",
  DATI_CLIENTE_MANCANTI: "Destinatario da completare",
  CLIENTE_NON_TROVATO: "Cliente non nel gestionale",
  CLIENTE_DA_VERIFICARE: "Cliente da verificare",
  CONFLITTO_INTERESSI: "Possibile conflitto di interessi",
  CONTROPARTE_DIRETTA: "Email alla controparte",
  RIFERIMENTO_TEMPORALE: "Date relative nel testo",
  CONFIDENZA_BASSA: "Affidabilità bassa",
  NESSUNA_AZIONE: "Nessuna azione individuata",
};

const WARNING_TITLES = {
  COLLEGA_ART38: "Art. 38, comma 2, del Codice deontologico forense",
  CONFLITTO_INTERESSI: "Possibile conflitto di interessi (art. 24 del Codice deontologico forense)",
};

const NEUTRAL_WARNINGS = new Set(["CLIENTE_NON_TROVATO", "CONFIDENZA_BASSA", "NESSUNA_AZIONE", "RIFERIMENTO_TEMPORALE"]);

const SEVERITY = {
  bloccante: { tone: "danger", label: "Bloccante", rank: 0 },
  attenzione: { tone: "warning", label: "Attenzione", rank: 1 },
  info: { tone: "info", label: "Nota", rank: 2 },
};

const RESULT_LABELS = { ok: "OK", errore: "Errore", saltata: "Saltata" };

const ARTIFACT_LINK_LABELS = { ics: "Scarica .ics", eml: "Scarica bozza email" };

const APPOINTMENT_STATUS = { fissato: "Fissato", da_fissare: "Da fissare" };
const APPOINTMENT_MODES = {
  in_studio: "In studio",
  telefonico: "Telefonico",
  videochiamata: "Videochiamata",
  altro: "Altro",
};
const ENGAGEMENT_STATUS = { conferito: "Conferito", in_valutazione: "In valutazione", non_conferito: "Non conferito" };
const FEE_BASIS = {
  forfait: "Forfettario",
  orario: "A ore",
  per_fasi: "Per fasi",
  percentuale: "A percentuale",
  altro: "Altro",
};
const DEADLINE_KINDS = {
  processuale: "Processuale",
  contrattuale: "Contrattuale",
  amministrativa: "Amministrativa",
  altro: "Altro",
};

/** Campi modificabili prima dell'approvazione, per tipo di azione. */
const EDIT_FIELDS = {
  appuntamento: [
    { key: "start", label: "Data e ora", input: "datetime-local", nullable: true },
    { key: "durationMinutes", label: "Durata (minuti)", input: "number", nullable: true, min: "1", step: "1" },
    { key: "location", label: "Luogo", input: "text", nullable: true },
  ],
  scadenza: [
    { key: "date", label: "Data", input: "date", nullable: true },
    { key: "time", label: "Ora", input: "time", nullable: true },
  ],
  email: [
    { key: "recipientEmail", label: "Indirizzo email del destinatario", input: "email", nullable: true },
    { key: "subject", label: "Oggetto", input: "text", required: true },
    { key: "body", label: "Testo", input: "textarea", required: true, rows: 12 },
  ],
  attivita: [
    { key: "description", label: "Descrizione", input: "textarea", required: true, rows: 3 },
    { key: "dueDate", label: "Entro il", input: "date", nullable: true },
  ],
  documenti: [
    { key: "items", label: "Documenti (uno per riga)", input: "lines", rows: 5 },
    { key: "dueDate", label: "Entro il", input: "date", nullable: true },
  ],
  incarico: [
    { key: "subject", label: "Oggetto dell'incarico", input: "text", required: true },
    { key: "clientName", label: "Cliente", input: "text", nullable: true },
    {
      key: "status",
      label: "Stato dell'incarico",
      input: "select",
      options: [
        { value: "conferito", label: "Conferito (pratica aperta)" },
        { value: "in_valutazione", label: "In valutazione" },
        { value: "non_conferito", label: "Non conferito" },
      ],
    },
  ],
  accordo_economico: [
    {
      key: "agreed",
      label: "Stato",
      input: "select",
      options: [
        { value: true, label: "Concordato" },
        { value: false, label: "Proposto, non ancora accettato" },
      ],
    },
    { key: "amount", label: "Importo (€)", input: "number", nullable: true, min: "0", step: "0.01" },
    {
      key: "plusVatAndCpa",
      label: "IVA e CPA",
      input: "select",
      options: [
        { value: true, label: "Oltre IVA e CPA" },
        { value: false, label: "Comprensivo di IVA e CPA" },
        { value: null, label: "Non indicato" },
      ],
    },
    { key: "advanceAmount", label: "Acconto (€)", input: "number", nullable: true, min: "0", step: "0.01" },
    { key: "paymentTerms", label: "Modalità di pagamento", input: "text", nullable: true },
  ],
};

/** IVA e CPA come le legge l'avvocato, in tutti e tre i casi. */
const VAT_LABELS = new Map([
  [true, "oltre IVA e CPA"],
  [false, "comprensivo di IVA e CPA"],
  [null, "IVA e CPA: non indicato"],
]);

// ---------------------------------------------------------------------------
// Icone (tracciati SVG costanti)
// ---------------------------------------------------------------------------

const ICONS = {
  appuntamento: [
    "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    "M3 10h18",
    "M8 3v4",
    "M16 3v4",
  ],
  incarico: [
    "M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
    "M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7",
    "M3 13h18",
  ],
  accordo_economico: ["M17 7.2A6 6 0 1 0 17 16.8", "M5 10.5h8", "M5 13.5h7"],
  scadenza: ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z", "M12 7v5l3.5 2"],
  documenti: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h6"],
  email: ["M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M3.5 7.5 12 13l8.5-5.5"],
  attivita: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8 12.5l2.8 2.8L16 9.5"],
  invio_trascrizione: ["M3 4h18v4H3z", "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8", "M10 12h4"],
  alert: [
    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    "M12 9v4",
    "M12 17h.01",
  ],
  info: ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z", "M12 11v5", "M12 8h.01"],
  success: ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z", "M8 12.5l2.8 2.8L16 9.5"],
  back: ["M15 18l-6-6 6-6"],
  refresh: ["M20 12a8 8 0 1 1-2.34-5.66", "M20 4v5h-5"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICONS[name] ?? ICONS.info) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Costruzione sicura del DOM
// ---------------------------------------------------------------------------

/** Chiavi impostate come proprietà dell'elemento invece che come attributi. */
const PROPERTY_KEYS = new Set(["checked", "disabled", "value", "open", "required"]);

/**
 * Crea un elemento. `text` diventa textContent, `class` className, `on*` listener;
 * i figli stringa diventano nodi di testo (mai HTML).
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = tag === "textarea" ? value : keepAmountsTogether(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (PROPERTY_KEYS.has(key)) node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === "") continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** Spazio unificatore tra "€" e l'importo, perché l'a capo non li separi (solo testo mostrato). */
function keepAmountsTogether(value) {
  return String(value).replace(/€ (?=[\d-])/g, "€\u00a0");
}

// ---------------------------------------------------------------------------
// Formattazione (italiano, fuso dello studio)
// ---------------------------------------------------------------------------

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function dateFormat(options) {
  try {
    return new Intl.DateTimeFormat("it-IT", { ...options, timeZone: state.config.timezone });
  } catch {
    return new Intl.DateTimeFormat("it-IT", options);
  }
}

function parseInstant(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatInstantLong(iso) {
  const date = parseInstant(iso);
  if (date === null) return iso;
  return dateFormat({
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Per le schede dell'elenco: "Oggi, 09:30", "Ieri, 18:10" o "lun 5 ott 2026, 09:30". */
function formatInstantShort(iso) {
  const date = parseInstant(iso);
  if (date === null) return iso;
  const dayKey = dateFormat({ year: "numeric", month: "2-digit", day: "2-digit" });
  const time = dateFormat({ hour: "2-digit", minute: "2-digit" }).format(date);
  const day = dayKey.format(date);
  if (day === dayKey.format(new Date())) return `Oggi, ${time}`;
  if (day === dayKey.format(new Date(Date.now() - 86_400_000))) return `Ieri, ${time}`;
  return dateFormat({
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Data locale "YYYY-MM-DD" come mezzogiorno UTC, o null se non è una data di calendario. */
function parseLocalDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  const valid =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
  return valid ? date : null;
}

const LOCAL_DATE_FORMAT = new Intl.DateTimeFormat("it-IT", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** "giovedì 15 ottobre 2026" per "2026-10-15". */
function formatLocalDate(value) {
  const match = LOCAL_DATE.exec(value ?? "");
  const date = match ? parseLocalDate(match[1], match[2], match[3]) : null;
  return date ? LOCAL_DATE_FORMAT.format(date) : `${value} (data non valida)`;
}

/** "giovedì 15 ottobre 2026, ore 10:00" per "2026-10-15T10:00". */
function formatLocalDateTime(value) {
  const match = LOCAL_DATE_TIME.exec(value ?? "");
  const date = match ? parseLocalDate(match[1], match[2], match[3]) : null;
  if (!match || !date || Number(match[4]) > 23 || Number(match[5]) > 59) return `${value} (data non valida)`;
  return `${LOCAL_DATE_FORMAT.format(date)}, ore ${match[4]}:${match[5]}`;
}

/** Minutaggio nella registrazione: "mm:ss" oppure "h:mm:ss". */
function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const hours = Math.floor(total / 3600);
  const mmss = `${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** Durata leggibile ("42 min", "1 h 05 min", "35 s"); stringa vuota se assente. */
function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${String(minutes).padStart(2, "0")} min` : `${minutes} min`;
}

// Raggruppamento sempre attivo: con i dati CLDR "it" alcuni browser scrivono 2500 invece di 2.500.
const AMOUNT_FORMAT = new Intl.NumberFormat("it-IT", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: "always",
});

/** Come formatAmount sul server: "€ 2.500,00", oppure "2.500,00 CHF" per le altre valute. */
function formatMoney(amount, currency) {
  const code = (currency || "").trim();
  if (code === "" || code.toUpperCase() === "EUR" || code === "€") {
    return `${amount < 0 ? "-" : ""}€ ${AMOUNT_FORMAT.format(Math.abs(amount))}`;
  }
  return `${AMOUNT_FORMAT.format(amount)} ${code}`;
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ---------------------------------------------------------------------------
// Stato, API e notifiche
// ---------------------------------------------------------------------------

const state = {
  config: { studioName: "", lawyerName: "", timezone: "Europe/Rome", syncAvailable: false },
  /** { proposal, transcript } della proposta aperta. */
  detail: null,
  /** Per ogni azione selezionabile: casella, campi modificabili e indicatore di modifica. */
  cards: new Map(),
  busy: false,
  renderToken: 0,
  navigated: false,
};

const main = document.getElementById("main");
const actionBar = document.getElementById("actionbar");
const statusRegion = document.getElementById("status");
const alertRegion = document.getElementById("alert");
let statusTimer = 0;

async function api(path, { method = "GET", body } = {}) {
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error("Impossibile contattare Seguito: verificare che il server sia in esecuzione e la connessione di rete.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data !== null && typeof data.error === "string" ? data.error : null;
    throw new Error(message ?? `Richiesta non riuscita (codice ${response.status}).`);
  }
  return data;
}

function announce(message) {
  window.clearTimeout(statusTimer);
  statusRegion.replaceChildren(h("p", { class: "toast toast--status", text: message }));
  statusTimer = window.setTimeout(() => statusRegion.replaceChildren(), 6000);
}

function showError(message) {
  const close = h("button", {
    type: "button",
    class: "toast__close",
    text: "Chiudi",
    onclick: () => alertRegion.replaceChildren(),
  });
  alertRegion.replaceChildren(
    h("div", { class: "toast toast--error" }, icon("alert"), h("p", { class: "toast__text", text: message }), close),
  );
}

function clearError() {
  alertRegion.replaceChildren();
}

function setBusy(busy) {
  state.busy = busy;
  main.setAttribute("aria-busy", String(busy));
  for (const button of document.querySelectorAll("#actionbar button, #refresh-button")) button.disabled = busy;
  if (!busy) updateSelectionUi();
}

// La barra delle azioni è fissa: il contenuto e le notifiche ne tengono conto.
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--bar-h", `${actionBar.offsetHeight}px`);
}).observe(actionBar);

// ---------------------------------------------------------------------------
// Navigazione
// ---------------------------------------------------------------------------

function currentRoute() {
  const match = /^#\/p\/(.+)$/.exec(window.location.hash);
  if (!match) return { name: "inbox" };
  try {
    return { name: "detail", id: decodeURIComponent(match[1]) };
  } catch {
    return { name: "inbox" };
  }
}

async function navigate() {
  const token = ++state.renderToken;
  clearError();
  window.clearTimeout(statusTimer);
  statusRegion.replaceChildren();
  hideActionBar();
  state.detail = null;
  state.cards = new Map();
  main.setAttribute("aria-busy", "true");
  main.replaceChildren(h("p", { class: "loading", text: "Caricamento…" }));
  const route = currentRoute();
  try {
    if (route.name === "detail") {
      const detail = await api(`/api/proposals/${encodeURIComponent(route.id)}`);
      if (token !== state.renderToken) return;
      state.detail = detail;
      renderDetail();
    } else {
      const items = await api("/api/proposals");
      if (token !== state.renderToken) return;
      renderInbox(items);
    }
  } catch (error) {
    if (token !== state.renderToken) return;
    renderLoadError(error.message, route.name === "detail");
  } finally {
    if (token === state.renderToken) main.setAttribute("aria-busy", "false");
  }
  if (state.navigated) {
    window.scrollTo(0, 0);
    main.querySelector("h1")?.focus({ preventScroll: true });
  }
}

/** Sostituisce il contenuto principale; le sezioni assenti (null) vengono ignorate. */
function setMain(...nodes) {
  main.replaceChildren(...nodes.filter(Boolean));
}

function backLink() {
  return h("a", { class: "back-link", href: "#/" }, icon("back"), "Tutte le registrazioni");
}

function renderLoadError(message, withBackLink) {
  document.title = "Seguito";
  setMain(
    withBackLink ? backLink() : null,
    h(
      "div",
      { class: "empty" },
      h("h1", { class: "empty__title", tabindex: "-1", text: "Impossibile caricare i dati" }),
      h("p", { text: message }),
      h("button", { type: "button", class: "btn btn--secondary", text: "Riprova", onclick: () => navigate() }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Elenco delle registrazioni
// ---------------------------------------------------------------------------

function renderInbox(items) {
  document.title = "Registrazioni – Seguito";
  const pending = items.filter((item) => item.status === "da_revisionare").length;
  const subtitle =
    items.length === 0
      ? "Nessuna registrazione elaborata"
      : `${plural(items.length, "registrazione", "registrazioni")} · ${pending} da revisionare`;
  const refresh = h(
    "button",
    { type: "button", class: "btn btn--secondary", id: "refresh-button", onclick: refreshInbox },
    icon("refresh"),
    "Aggiorna",
  );
  setMain(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "page-head__text" },
        h("h1", { tabindex: "-1", text: "Registrazioni" }),
        h("p", { class: "muted", text: subtitle }),
      ),
      refresh,
    ),
    items.length === 0 ? emptyInbox() : h("ul", { class: "card-list" }, items.map(proposalCard)),
  );
}

function emptyInbox() {
  const hint = state.config.syncAvailable
    ? "Premere «Aggiorna» per cercare nuove registrazioni del Plaud."
    : "Le registrazioni elaborate compariranno qui.";
  return h(
    "div",
    { class: "empty" },
    h("p", { class: "empty__title", text: "Nessuna registrazione da mostrare" }),
    h("p", { class: "muted", text: hint }),
  );
}

function actionsCountText(item) {
  if (item.actionsCount === 0) return "Nessuna azione proposta";
  const total = plural(item.actionsCount, "azione proposta", "azioni proposte");
  const selected =
    item.preselectedCount === 0
      ? "nessuna preselezionata"
      : plural(item.preselectedCount, "preselezionata", "preselezionate");
  return `${total} · ${selected}`;
}

function warningBadge(code) {
  const tone = code === "COLLEGA_ART38" ? "danger" : NEUTRAL_WARNINGS.has(code) ? "neutral" : "warning";
  return h("li", { class: `badge badge--${tone}`, text: WARNING_LABELS[code] ?? code });
}

const EXECUTED_STATUSES = new Set(["eseguita", "eseguita_parzialmente"]);

/** Testo per le scadenze proposte e non ancora nel calendario; null se nessuna o se la proposta non è stata eseguita. */
function pendingDeadlinesText(status, count, capitalized) {
  if (!EXECUTED_STATUSES.has(status) || count === 0) return null;
  if (count === 1) return capitalized ? "Una scadenza proposta non è ancora nel calendario" : "Scadenza non in calendario";
  return capitalized ? `${count} scadenze proposte non sono ancora nel calendario` : `${count} scadenze non in calendario`;
}

function statusChip(status) {
  return h("span", { class: `chip chip--${status}`, text: STATUS_LABELS[status] ?? status });
}

function proposalCard(item) {
  const meta = [CONVERSATION_LABELS[item.conversationType], formatDuration(item.durationMs)].filter(Boolean);
  return h(
    "li",
    { class: item.hasBlocking ? "card card--blocking" : "card" },
    h(
      "div",
      { class: "card__top" },
      statusChip(item.status),
      h("time", { class: "card__date", datetime: item.startedAt, text: formatInstantShort(item.startedAt) }),
    ),
    h(
      "h2",
      { class: "card__title" },
      h("a", {
        class: "card__link",
        href: `#/p/${encodeURIComponent(item.id)}`,
        text: item.title || "Registrazione senza titolo",
      }),
    ),
    meta.length > 0 ? h("p", { class: "card__meta", text: meta.join(" · ") }) : null,
    item.summary ? h("p", { class: "card__summary", text: item.summary }) : null,
    h("p", { class: "card__count", text: actionsCountText(item) }),
    badgesList(item),
  );
}

function badgesList(item) {
  const pending = pendingDeadlinesText(item.status, item.pendingDeadlines ?? 0, false);
  const badges = [
    ...item.warningCodes.map(warningBadge),
    pending ? h("li", { class: "badge badge--warning", text: pending }) : null,
  ].filter(Boolean);
  return badges.length > 0 ? h("ul", { class: "badges", "aria-label": "Avvisi" }, badges) : null;
}

function syncMessage(result) {
  const base =
    result.processed === 0
      ? "Nessuna nuova registrazione da elaborare."
      : `Sincronizzazione completata: ${plural(result.processed, "nuova registrazione elaborata", "nuove registrazioni elaborate")}.`;
  const waiting = Number(result.notReady) || 0;
  const postponed = Number(result.postponed) || 0;
  const parts = [base];
  if (waiting > 0) {
    parts.push(
      `${plural(waiting, "registrazione è", "registrazioni sono")} ancora senza trascrizione: verranno riprovate al prossimo aggiornamento.`,
    );
  }
  if (postponed > 0) {
    parts.push(
      `${plural(postponed, "analisi non riuscita in precedenza non è stata ripetuta", "analisi non riuscite in precedenza non sono state ripetute")} in questo aggiornamento.`,
    );
  }
  return parts.join(" ");
}

async function refreshInbox() {
  if (state.busy) return;
  const token = state.renderToken;
  setBusy(true);
  try {
    let message = "Elenco aggiornato.";
    if (state.config.syncAvailable) {
      const result = await api("/api/sync", { method: "POST" });
      message = syncMessage(result);
      if (result.errors.length > 0) {
        showError(`Alcune registrazioni non sono state elaborate: ${result.errors.join(" · ")}`);
      }
    }
    const items = await api("/api/proposals");
    if (token !== state.renderToken) return;
    renderInbox(items);
    announce(message);
    document.getElementById("refresh-button")?.focus();
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Dettaglio della proposta
// ---------------------------------------------------------------------------

/** Come sul server: una proposta eseguita resta approvabile per le azioni non ancora eseguite. */
function isEditable(proposal) {
  if (proposal.status === "da_revisionare" || proposal.status === "eseguita_parzialmente") return true;
  if (proposal.status !== "eseguita") return false;
  const done = new Set(proposal.executions.filter((result) => result.status === "ok").map((result) => result.actionId));
  return proposal.actions.some((action) => !done.has(action.id));
}

/** Testo di conferma se la proposta ha avvisi bloccanti, altrimenti null. */
function blockingConfirmText(proposal) {
  const blocking = [...proposal.warnings, ...proposal.actions.flatMap((action) => action.warnings)].filter(
    (warning) => warning.severity === "bloccante",
  );
  if (blocking.length === 0) return null;
  const reason = blocking.some((warning) => warning.code === "COLLEGA_ART38")
    ? "un avviso bloccante (art. 38, comma 2, del Codice deontologico forense)"
    : "un avviso bloccante";
  return `Questa registrazione ha ${reason}. Eseguire comunque le azioni selezionate?`;
}

function renderDetail() {
  const { proposal, transcript } = state.detail;
  const editable = isEditable(proposal);
  state.cards = new Map();
  document.title = `${proposal.recording.title || "Registrazione"} – Seguito`;
  setMain(
    backLink(),
    detailHeader(proposal),
    proposalBanners(proposal),
    executionsSection(proposal),
    section("sintesi", "Sintesi", h("p", { class: "prose panel", text: proposal.summary || "Sintesi non disponibile." })),
    participantsSection(proposal.participants),
    actionsSection(proposal, editable),
    doubtsSection(proposal.doubts),
    transcriptSection(transcript, proposal.participants),
    analysisNote(proposal),
  );
  renderActionBar(proposal, editable);
}

function section(id, title, ...content) {
  return h(
    "section",
    { class: "section", "aria-labelledby": `${id}-titolo` },
    h("h2", { id: `${id}-titolo`, text: title }),
    ...content,
  );
}

function detailHeader(proposal) {
  const { recording } = proposal;
  const duration = formatDuration(recording.durationMs);
  const meta = [
    h("time", { datetime: recording.startedAt, text: formatInstantLong(recording.startedAt) }),
    duration ? h("span", { class: "nowrap", text: `Durata ${duration}` }) : null,
    SOURCE_LABELS[recording.source] ? h("span", { class: "nowrap", text: SOURCE_LABELS[recording.source] }) : null,
  ].filter(Boolean);
  return h(
    "header",
    { class: "detail-head" },
    h(
      "div",
      { class: "detail-head__chips" },
      statusChip(proposal.status),
      h("span", { class: "chip chip--neutral", text: CONVERSATION_LABELS[proposal.conversationType] ?? "" }),
    ),
    h("h1", { tabindex: "-1", text: recording.title || "Registrazione senza titolo" }),
    h(
      "p",
      { class: "detail-head__meta" },
      meta.flatMap((part, index) => (index === 0 ? [part] : [" · ", part])),
    ),
  );
}

function banner(tone, title, text) {
  const iconName = tone === "danger" || tone === "warning" ? "alert" : tone === "success" ? "success" : "info";
  return h(
    "div",
    { class: `banner banner--${tone}` },
    icon(iconName, "icon banner__icon"),
    h(
      "div",
      { class: "banner__body" },
      h("p", { class: "banner__title", text: title }),
      h("p", { class: "banner__text", text }),
    ),
  );
}

function proposalBanners(proposal) {
  const warnings = [...proposal.warnings].sort(
    (a, b) => (SEVERITY[a.severity]?.rank ?? 3) - (SEVERITY[b.severity]?.rank ?? 3),
  );
  const blocking = warnings.filter((warning) => warning.severity === "bloccante");
  const others = warnings.filter((warning) => warning.severity !== "bloccante");
  const toBanner = (warning) =>
    banner(
      SEVERITY[warning.severity]?.tone ?? "info",
      WARNING_TITLES[warning.code] ?? WARNING_LABELS[warning.code] ?? warning.code,
      warning.message,
    );
  const note = STATUS_NOTES[proposal.status];
  const pendingHint =
    proposal.status === "eseguita" && isEditable(proposal)
      ? " Le azioni non selezionate restano nell'elenco e si possono approvare anche in seguito."
      : "";
  const done = new Set(proposal.executions.filter((result) => result.status === "ok").map((result) => result.actionId));
  const pendingDeadlines = proposal.actions.filter((action) => action.payload.type === "scadenza" && !done.has(action.id));
  const pending = pendingDeadlinesText(proposal.status, pendingDeadlines.length, true);
  const banners = [
    ...blocking.map(toBanner),
    note ? banner(note.tone, note.title, `${note.text}${pendingHint}`) : null,
    pending
      ? banner(
          "warning",
          "Scadenze non in calendario",
          `${pending}: ${pendingDeadlines.length === 1 ? "verificarla e, se necessario, approvarla" : "verificarle e, se necessario, approvarle"}.`,
        )
      : null,
    ...others.map(toBanner),
  ].filter(Boolean);
  return banners.length > 0 ? h("div", { class: "banners" }, banners) : null;
}

function participantsSection(participants) {
  if (participants.length === 0) {
    return section("partecipanti", "Partecipanti", h("p", { class: "muted", text: "Nessun partecipante individuato." }));
  }
  return section(
    "partecipanti",
    "Partecipanti",
    h(
      "ul",
      { class: "people" },
      participants.map((person) => {
        const displayName = person.name || person.organization || person.speakerLabel || "Persona non identificata";
        const meta = [
          ROLE_LABELS[person.role] ?? person.role,
          person.name ? person.organization : null,
          person.isSpeaker
            ? displayName !== person.speakerLabel
              ? person.speakerLabel
              : null
            : "non presente alla conversazione",
        ].filter(Boolean);
        const contacts = [person.phone, person.email].filter(Boolean);
        return h(
          "li",
          { class: "person" },
          h("p", { class: "person__name", text: displayName }),
          h("p", { class: "person__meta", text: meta.join(" · ") }),
          contacts.length > 0 ? h("p", { class: "person__meta", text: contacts.join(" · ") }) : null,
          person.clientMatch
            ? h(
                "p",
                { class: "person__match" },
                icon("check", "icon icon--sm"),
                `Nel gestionale: ${person.clientMatch.displayName}`,
              )
            : null,
        );
      }),
    ),
  );
}

/** Titolo e righe leggibili di un'azione. Valori nulli o vuoti vengono omessi. */
function describeAction(payload) {
  switch (payload.type) {
    case "appuntamento":
      return {
        title: payload.title,
        rows: [
          ["Stato", APPOINTMENT_STATUS[payload.status]],
          ["Data e ora", payload.start ? formatLocalDateTime(payload.start) : "Da definire"],
          ["Durata", payload.durationMinutes !== null ? plural(payload.durationMinutes, "minuto", "minuti") : null],
          ["Luogo", payload.location],
          ["Modalità", APPOINTMENT_MODES[payload.mode]],
          ["Partecipanti", payload.participants.join(", ")],
          ["Note", payload.notes],
        ],
      };
    case "incarico":
      return {
        title: payload.subject,
        rows: [
          ["Stato", ENGAGEMENT_STATUS[payload.status]],
          ["Cliente", payload.clientName],
          ["Materia", payload.matterType],
          ["Controparte", payload.counterpart],
          ["Urgenza", payload.urgency],
          ["Note", payload.notes],
        ],
      };
    case "accordo_economico":
      return {
        title: payload.description,
        rows: [
          ["Stato", payload.agreed ? "Concordato" : "Proposto, non ancora accettato"],
          [
            "Importo",
            payload.amount !== null
              ? `${formatMoney(payload.amount, payload.currency)} ${VAT_LABELS.get(payload.plusVatAndCpa) ?? ""}`.trim()
              : null,
          ],
          ["Compenso", FEE_BASIS[payload.basis]],
          ["Tariffa oraria", payload.hourlyRate !== null ? `${formatMoney(payload.hourlyRate, payload.currency)} all'ora` : null],
          ["Acconto", payload.advanceAmount !== null ? formatMoney(payload.advanceAmount, payload.currency) : null],
          ["Pagamento", payload.paymentTerms],
        ],
      };
    case "scadenza":
      return {
        title: payload.title,
        rows: [
          [
            "Data",
            payload.date ? `${formatLocalDate(payload.date)}${payload.time ? `, ore ${payload.time}` : ""}` : "Da definire",
          ],
          ["Tipo", DEADLINE_KINDS[payload.kind]],
          ["Riferimento normativo", payload.legalBasis],
          ["Calcolo", payload.computation],
          ["Note", payload.notes],
        ],
      };
    case "documenti":
      return {
        title: payload.direction === "da_ricevere" ? "Documenti da ricevere" : "Documenti da inviare",
        rows: [
          [
            "Documenti",
            payload.items.length > 0
              ? h("ul", { class: "plain-list" }, payload.items.map((item) => h("li", { text: item })))
              : "Nessun documento indicato",
          ],
          [payload.direction === "da_ricevere" ? "Da ricevere da" : "Da inviare a", payload.counterpartName],
          ["Entro il", payload.dueDate ? formatLocalDate(payload.dueDate) : null],
        ],
      };
    case "email":
      return {
        title: payload.subject,
        rows: [
          ["Destinatario", [payload.recipientName, ROLE_LABELS[payload.recipientRole]].filter(Boolean).join(" · ")],
          ["Indirizzo", payload.recipientEmail ?? "Da completare prima dell'invio"],
          ["Scopo", payload.purpose],
          ["Testo", h("div", { class: "email-body", text: payload.body })],
        ],
      };
    case "attivita":
      return {
        title: payload.description,
        rows: [
          ["Assegnata a", payload.assignee],
          ["Entro il", payload.dueDate ? formatLocalDate(payload.dueDate) : null],
        ],
      };
    case "invio_trascrizione":
      return { title: "Trascrizione alla casella dello studio", rows: [["Destinatario", payload.to]] };
    default:
      return { title: ACTION_LABELS[payload.type] ?? "Azione", rows: [] };
  }
}

function fieldsList(rows) {
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (visible.length === 0) return null;
  return h(
    "dl",
    { class: "fields" },
    visible.map(([label, value]) => h("div", { class: "fields__row" }, h("dt", { text: label }), h("dd", {}, value))),
  );
}

function warningsList(warnings) {
  if (warnings.length === 0) return null;
  return h(
    "ul",
    { class: "warnings" },
    warnings.map((warning) => {
      const severity = SEVERITY[warning.severity] ?? SEVERITY.info;
      return h(
        "li",
        { class: `warning warning--${severity.tone}` },
        icon(warning.severity === "info" ? "info" : "alert", "icon icon--sm"),
        h("span", {}, h("span", { class: "sr-only", text: `${severity.label}: ` }), warning.message),
      );
    }),
  );
}

function confidenceText(action) {
  if (action.origin === "sistema") return "Azione predisposta dal sistema";
  const level = action.confidence >= 0.85 ? "alta" : action.confidence >= 0.6 ? "media" : "bassa";
  return `Affidabilità ${level}`;
}

function evidenceChip(evidence) {
  const time = evidence.startMs !== null ? formatTimestamp(evidence.startMs) : "—";
  return h(
    "button",
    {
      type: "button",
      class: evidence.verified ? "evidence-chip" : "evidence-chip evidence-chip--unverified",
      title: "Mostra il passaggio nella trascrizione",
      onclick: () => showSegment(evidence.segment),
    },
    h("span", { class: "evidence-chip__time", text: `[${time}]` }),
    h("span", { class: "evidence-chip__quote", text: `«${evidence.quote}»` }),
    evidence.verified ? null : h("span", { class: "evidence-chip__flag", text: "citazione non trovata" }),
  );
}

function evidenceList(evidence) {
  if (evidence.length === 0) return null;
  return h(
    "div",
    { class: "evidence" },
    h("p", { class: "evidence__label", text: "Dalla trascrizione" }),
    h("ul", { class: "evidence__list" }, evidence.map((item) => h("li", {}, evidenceChip(item)))),
  );
}

function showSegment(index) {
  const transcript = document.getElementById("trascrizione");
  const target = document.getElementById(`segmento-${index}`);
  if (transcript === null || target === null) {
    showError("Il passaggio citato non è presente nella trascrizione.");
    return;
  }
  transcript.open = true;
  for (const element of document.querySelectorAll(".segment--highlight")) {
    element.classList.remove("segment--highlight");
  }
  target.classList.add("segment--highlight");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  target.focus({ preventScroll: true });
}

function toInputValue(spec, value) {
  // Per le scelte il valore del controllo è la posizione dell'opzione (i valori possono essere booleani o null).
  if (spec.input === "select") return String(Math.max(0, spec.options.findIndex((option) => option.value === value)));
  if (value === null || value === undefined) return "";
  if (spec.input === "lines") return Array.isArray(value) ? value.join("\n") : "";
  return String(value);
}

function fromInputValue(spec, raw) {
  if (spec.input === "select") return spec.options[Number(raw)]?.value ?? null;
  if (spec.input === "lines") {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  const trimmed = raw.trim();
  if (trimmed === "") return spec.nullable ? null : "";
  return spec.input === "number" ? Number(trimmed) : trimmed;
}

/** Errore di compilazione di un campo, mostrato prima di inviare l'approvazione. */
class FieldError extends Error {
  constructor(message, control) {
    super(message);
    this.control = control;
  }
}

function editorControl(spec, id, onEdit) {
  if (spec.input === "select") {
    const options = spec.options.map((option, optionIndex) => h("option", { value: String(optionIndex), text: option.label }));
    return h("select", { id, class: "input", onchange: onEdit }, options);
  }
  if (spec.input === "textarea" || spec.input === "lines") {
    return h("textarea", { id, class: "input", rows: spec.rows ?? 4, required: spec.required, oninput: onEdit });
  }
  return h("input", {
    id,
    class: "input",
    type: spec.input,
    required: spec.required,
    min: spec.min,
    step: spec.step,
    inputmode: spec.input === "number" ? (spec.step === "1" ? "numeric" : "decimal") : undefined,
    autocomplete: "off",
    oninput: onEdit,
  });
}

function buildEditor(action, index, onEdit) {
  const specs = EDIT_FIELDS[action.payload.type];
  if (specs === undefined) return { node: null, fields: [] };
  const fields = specs.map((spec, fieldIndex) => {
    const id = `azione-${index}-campo-${fieldIndex}`;
    const control = editorControl(spec, id, onEdit);
    control.value = toInputValue(spec, action.payload[spec.key]);
    // Valore riletto dopo l'assegnazione: il browser può averlo normalizzato.
    const initial = control.value;
    const wrapper = h("div", { class: "field" }, h("label", { class: "field__label", for: id, text: spec.label }), control);
    return { spec, control, initial, wrapper };
  });
  const node = h(
    "details",
    { class: "edit" },
    h("summary", { class: "edit__summary" }, icon("edit", "icon icon--sm"), "Modifica"),
    h(
      "div",
      { class: "edit__body" },
      fields.map((field) => field.wrapper),
      h("p", {
        class: "edit__hint",
        text: "Le modifiche vengono applicate solo se l'azione è selezionata al momento dell'approvazione.",
      }),
    ),
  );
  return { node, fields };
}

function lastResultFor(proposal, actionId) {
  return proposal.executions.filter((result) => result.actionId === actionId).at(-1) ?? null;
}

function actionCard(action, index, proposal, editable) {
  const done = proposal.executions.some((result) => result.actionId === action.id && result.status === "ok");
  const selectable = editable && !done;
  const lastResult = lastResultFor(proposal, action.id);
  const view = describeAction(action.payload);
  const titleId = `azione-${index}-titolo`;
  const typeLine = h(
    "span",
    { class: "action__type" },
    icon(action.payload.type, "icon icon--sm"),
    ACTION_LABELS[action.payload.type] ?? action.payload.type,
  );
  const title = h("span", { class: "action__title", id: titleId, text: view.title || "Senza titolo" });
  const editedChip = h("span", { class: "chip chip--edited", text: "Modificata", hidden: true });
  const resultChip = lastResult
    ? h("span", {
        class: `chip chip--${done ? "ok" : lastResult.status}`,
        text: done ? "Già eseguita" : `Ultimo esito: ${RESULT_LABELS[lastResult.status] ?? lastResult.status}`,
      })
    : null;

  const card = h("article", { class: "action", "aria-labelledby": titleId });
  if (!selectable) {
    card.append(
      h("div", { class: "action__head" }, h("div", { class: "action__label" }, typeLine, title, h("span", { class: "action__chips" }, resultChip))),
    );
  } else {
    const checkboxId = `azione-${index}`;
    const checkbox = h("input", {
      type: "checkbox",
      class: "action__checkbox",
      id: checkboxId,
      checked: action.preselected,
      onchange: updateSelectionUi,
    });
    card.append(
      h(
        "div",
        { class: "action__head" },
        checkbox,
        h("label", { class: "action__label", for: checkboxId }, typeLine, title, h("span", { class: "action__chips" }, editedChip, resultChip)),
      ),
    );
    const editor = buildEditor(action, index, () => {
      editedChip.hidden = !editor.fields.some((field) => field.control.value !== field.initial);
    });
    state.cards.set(action.id, { card, checkbox, fields: editor.fields, label: view.title });
    card.append(...[editor.node].filter(Boolean));
  }

  const details = [
    fieldsList(view.rows),
    warningsList(action.warnings),
    action.rationale
      ? h("p", { class: "action__why" }, h("span", { class: "action__why-label", text: "Motivo: " }), action.rationale)
      : null,
    evidenceList(action.evidence),
    h("p", { class: "action__meta", title: `Affidabilità stimata: ${Math.round(action.confidence * 100)}%`, text: confidenceText(action) }),
  ].filter(Boolean);
  // I dettagli stanno tra l'intestazione e il riquadro "Modifica".
  card.firstElementChild.after(...details);
  return card;
}

function actionsSection(proposal, editable) {
  const intro = editable
    ? h("p", {
        class: "section__intro",
        text: "Selezionare le azioni da eseguire; prima dell'approvazione è possibile modificarle. Nulla viene eseguito senza conferma.",
      })
    : null;
  const content =
    proposal.actions.length === 0
      ? h("p", { class: "muted", text: "Nessuna azione proposta." })
      : h(
          "div",
          { class: "actions" },
          proposal.actions.map((action, index) => actionCard(action, index, proposal, editable)),
        );
  return section("azioni", "Azioni proposte", intro, content);
}

function doubtsSection(doubts) {
  if (doubts.length === 0) return null;
  return section(
    "dubbi",
    "Dubbi da chiarire",
    h(
      "ul",
      { class: "doubts" },
      doubts.map((doubt) => h("li", { class: "doubt" }, h("p", { class: "doubt__text", text: doubt.text }), evidenceList(doubt.evidence))),
    ),
  );
}

function transcriptSection(transcript, participants) {
  const names = new Map(
    participants.filter((person) => person.speakerLabel && person.name).map((person) => [person.speakerLabel, person.name]),
  );
  const segments = transcript.segments;
  const speaker = (label) => (names.has(label) ? `${label} (${names.get(label)})` : label);
  const body =
    segments.length === 0
      ? h("p", { class: "muted transcript__empty", text: "La trascrizione non è disponibile nell'archivio." })
      : h(
          "ol",
          { class: "segments" },
          segments.map((segment) =>
            h(
              "li",
              { class: "segment", id: `segmento-${segment.index}`, tabindex: "-1" },
              h("span", { class: "segment__time", text: `[${formatTimestamp(segment.startMs)}]` }),
              " ",
              h("span", { class: "segment__speaker", text: speaker(segment.speaker) }),
              ": ",
              h("span", { class: "segment__text", text: segment.text }),
            ),
          ),
        );
  return h(
    "section",
    { class: "section" },
    h(
      "details",
      { class: "transcript", id: "trascrizione" },
      h(
        "summary",
        { class: "transcript__summary" },
        h("h2", { text: "Trascrizione" }),
        h("span", { class: "muted", text: segments.length > 0 ? plural(segments.length, "intervento", "interventi") : "non disponibile" }),
      ),
      body,
    ),
  );
}

/** Nomi degli estrattori come li legge l'avvocato. */
const EXTRACTOR_LABELS = { claude: "Claude", fixture: "analisi di esempio precompilata" };

function analysisNote(proposal) {
  const { extractor } = proposal;
  const name = Object.hasOwn(EXTRACTOR_LABELS, extractor.name) ? EXTRACTOR_LABELS[extractor.name] : extractor.name;
  const engine = extractor.model ? `${name} (${extractor.model})` : name;
  return h("p", { class: "analysis-note", text: `Analisi: ${engine} · ${formatInstantLong(proposal.createdAt)}` });
}

// ---------------------------------------------------------------------------
// Esito dell'esecuzione
// ---------------------------------------------------------------------------

function outboxHref(path) {
  return `/outbox/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function artifactItem(artifact) {
  if (artifact.path) {
    return h(
      "li",
      { class: "artifact" },
      h(
        "a",
        { class: "btn btn--link", href: outboxHref(artifact.path), download: "" },
        icon("download", "icon icon--sm"),
        ARTIFACT_LINK_LABELS[artifact.kind] ?? "Scarica file",
      ),
      artifact.label ? h("span", { class: "artifact__label", text: artifact.label }) : null,
    );
  }
  return h(
    "li",
    { class: "artifact artifact--note" },
    icon(artifact.kind === "gestionale" ? "folder" : "check", "icon icon--sm"),
    h("span", { class: "artifact__label", text: artifact.label || artifact.ref || "" }),
  );
}

function resultItem(result, actionsById) {
  const action = actionsById.get(result.actionId);
  const label = action
    ? `${ACTION_LABELS[action.payload.type] ?? action.payload.type} – ${describeAction(action.payload).title}`
    : result.actionId;
  return h(
    "li",
    { class: `result result--${result.status}` },
    h(
      "div",
      { class: "result__head" },
      h("span", { class: `chip chip--${result.status}`, text: RESULT_LABELS[result.status] ?? result.status }),
      h("span", { class: "result__label", text: label }),
    ),
    result.message ? h("p", { class: "result__message", text: result.message }) : null,
    result.artifacts.length > 0 ? h("ul", { class: "artifacts" }, result.artifacts.map(artifactItem)) : null,
  );
}

/** Esecuzioni raggruppate per approvazione (stesso istante), dalla più recente. */
function executionGroups(executions) {
  const groups = [];
  for (const result of executions) {
    const last = groups.at(-1);
    if (last && last.at === result.executedAt) last.results.push(result);
    else groups.push({ at: result.executedAt, results: [result] });
  }
  return groups.reverse();
}

function executionsSection(proposal) {
  if (proposal.executions.length === 0) return null;
  const actionsById = new Map(proposal.actions.map((action) => [action.id, action]));
  const groups = executionGroups(proposal.executions);
  const node = section(
    "esito",
    "Esito dell'approvazione",
    groups.map((group) =>
      h(
        "div",
        { class: "exec-group" },
        groups.length > 1 ? h("p", { class: "exec-group__when", text: `Approvazione di ${formatInstantLong(group.at)}` }) : null,
        h("ul", { class: "results" }, group.results.map((result) => resultItem(result, actionsById))),
      ),
    ),
  );
  node.id = "esito";
  node.tabIndex = -1;
  return node;
}

function resultsSummary(results) {
  const count = (status) => results.filter((result) => result.status === status).length;
  const parts = [
    count("ok") > 0 ? plural(count("ok"), "azione eseguita", "azioni eseguite") : null,
    count("errore") > 0 ? `${count("errore")} con errore` : null,
    count("saltata") > 0 ? plural(count("saltata"), "saltata", "saltate") : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Approvazione completata: ${parts.join(", ")}.` : "Approvazione completata.";
}

// ---------------------------------------------------------------------------
// Barra delle azioni: selezione, approvazione, scarto
// ---------------------------------------------------------------------------

function hideActionBar() {
  actionBar.hidden = true;
  actionBar.replaceChildren();
}

function renderActionBar(proposal, editable) {
  if (!editable) {
    hideActionBar();
    return;
  }
  actionBar.replaceChildren(
    h(
      "div",
      { class: "actionbar__inner", role: "group", "aria-label": "Azioni sulla proposta" },
      h("button", { type: "button", class: "btn btn--secondary", id: "toggle-all", onclick: toggleAll }),
      proposal.status === "da_revisionare"
        ? h("button", { type: "button", class: "btn btn--danger", id: "discard", text: "Scarta", onclick: discardProposal })
        : null,
      h("button", { type: "button", class: "btn btn--primary", id: "approve", onclick: approveSelected }),
    ),
  );
  actionBar.hidden = false;
  updateSelectionUi();
}

function selectedActionIds() {
  return [...state.cards].filter(([, entry]) => entry.checkbox.checked).map(([id]) => id);
}

function updateSelectionUi() {
  const entries = [...state.cards.values()];
  const selected = entries.filter((entry) => entry.checkbox.checked).length;
  for (const entry of entries) entry.card.classList.toggle("action--selected", entry.checkbox.checked);
  const approve = document.getElementById("approve");
  const toggle = document.getElementById("toggle-all");
  if (approve) {
    approve.textContent = `Approva selezionate (${selected})`;
    approve.disabled = state.busy || selected === 0;
  }
  if (toggle) {
    toggle.textContent = entries.length > 0 && selected === entries.length ? "Deseleziona" : "Seleziona tutto";
    toggle.disabled = state.busy || entries.length === 0;
  }
}

function toggleAll() {
  const entries = [...state.cards.values()];
  const selectAll = entries.some((entry) => !entry.checkbox.checked);
  for (const entry of entries) entry.checkbox.checked = selectAll;
  updateSelectionUi();
}

/** Solo i campi cambiati, e solo per le azioni approvate. */
function collectEdits(actionIds) {
  const edits = {};
  for (const id of actionIds) {
    const entry = state.cards.get(id);
    for (const field of entry.fields) {
      const { control, spec } = field;
      if (control.value === field.initial) continue;
      if (spec.required && control.value.trim() === "") {
        throw new FieldError(`«${entry.label}»: il campo «${spec.label}» non può essere vuoto.`, control);
      }
      if (!control.checkValidity()) {
        throw new FieldError(`«${entry.label}»: il valore del campo «${spec.label}» non è valido.`, control);
      }
      edits[id] = { ...edits[id], [spec.key]: fromInputValue(spec, control.value) };
    }
  }
  return edits;
}

function focusField(control) {
  const details = control.closest("details");
  if (details) details.open = true;
  control.focus();
}

async function approveSelected() {
  if (state.busy || state.detail === null) return;
  const proposal = state.detail.proposal;
  const actionIds = selectedActionIds();
  if (actionIds.length === 0) {
    showError("Selezionare almeno un'azione da approvare.");
    return;
  }
  let edits;
  try {
    edits = collectEdits(actionIds);
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    showError(error.message);
    focusField(error.control);
    return;
  }
  const confirmText = blockingConfirmText(proposal);
  if (confirmText !== null && !window.confirm(confirmText)) return;
  clearError();
  setBusy(true);
  document.getElementById("approve").textContent = "Approvazione in corso…";
  const previousCount = proposal.executions.length;
  try {
    const body = Object.keys(edits).length > 0 ? { actionIds, edits } : { actionIds };
    const updated = await api(`/api/proposals/${encodeURIComponent(proposal.id)}/approve`, { method: "POST", body });
    state.detail = { ...state.detail, proposal: updated };
    renderDetail();
    announce(resultsSummary(updated.executions.slice(previousCount)));
    const outcome = document.getElementById("esito");
    outcome?.scrollIntoView({ block: "start" });
    outcome?.focus({ preventScroll: true });
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function discardProposal() {
  if (state.busy || state.detail === null) return;
  if (!window.confirm("Scartare questa proposta? Nessuna azione verrà eseguita.")) return;
  const proposal = state.detail.proposal;
  clearError();
  setBusy(true);
  try {
    const updated = await api(`/api/proposals/${encodeURIComponent(proposal.id)}/discard`, { method: "POST" });
    state.detail = { ...state.detail, proposal: updated };
    renderDetail();
    announce("Proposta scartata: nessuna azione è stata eseguita.");
    window.scrollTo(0, 0);
    main.querySelector("h1")?.focus({ preventScroll: true });
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

async function start() {
  try {
    state.config = { ...state.config, ...(await api("/api/config")) };
  } catch (error) {
    showError(error.message);
  }
  document.getElementById("studio-name").textContent = state.config.studioName;
  window.addEventListener("hashchange", () => {
    state.navigated = true;
    void navigate();
  });
  await navigate();
}

void start();
