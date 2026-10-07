import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExecutionContext } from "../src/actions/executor.js";
import { defaultExecutors, splitPersonName } from "../src/actions/executors.js";
import type {
  ActionPayload,
  CaseManagementData,
  ExecutionResult,
  Proposal,
  ProposalParticipant,
  ProposedAction,
  Recording,
  StudioProfile,
} from "../src/domain/types.js";
import { JsonCaseManagement } from "../src/enrich/json-case-management.js";

const NOW = new Date("2026-10-07T08:00:00.000Z");

const STUDIO: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone\nStudio Legale Sapone",
};

const RECORDING: Recording = {
  id: "plaud:demo-rossi",
  source: "plaud",
  externalId: "demo-rossi",
  title: "Chiamata Mario Rossi – decreto ingiuntivo",
  startedAt: "2026-10-07T07:30:00.000Z",
  durationMs: 840_000,
  segments: [
    { index: 1, startMs: 4_000, endMs: 9_000, speaker: "Speaker 2", text: "Buongiorno avvocato, sono Mario Rossi." },
    { index: 0, startMs: 0, endMs: 4_000, speaker: "Speaker 1", text: "Studio Sapone, buongiorno." },
    { index: 2, startMs: 754_000, endMs: null, speaker: "Speaker 1", text: "Ci vediamo giovedì alle dieci." },
  ],
  plaudSummary: null,
  fetchedAt: "2026-10-07T08:00:00.000Z",
};

const GESTIONALE: CaseManagementData = {
  clients: [
    client("C-0001", "Mario", "Rossi", "mario.rossi@example.com"),
    client("C-0002", "Laura", "Neri", "laura.neri@example.com"),
    client("C-0003", "Anna", "Bruni", null),
  ],
  matters: [
    {
      id: "M-0001",
      clientId: "C-0002",
      number: "2025/087",
      title: "Neri c/ Condominio Via Manzoni 12 – infiltrazioni",
      status: "aperta",
      openedAt: "2025-05-10T08:00:00.000Z",
      notes: [],
    },
    {
      id: "M-0002",
      clientId: "C-0001",
      number: "2026/004",
      title: "Rossi – recupero crediti",
      status: "chiusa",
      openedAt: "2026-01-15T08:00:00.000Z",
      notes: [],
    },
  ],
};

function client(id: string, firstName: string, lastName: string, email: string | null) {
  return {
    id,
    kind: "persona_fisica" as const,
    displayName: `${firstName} ${lastName}`,
    firstName,
    lastName,
    companyName: null,
    taxCode: null,
    vatNumber: null,
    email,
    pec: null,
    phone: null,
    address: null,
  };
}

function participant(overrides: Partial<ProposalParticipant>): ProposalParticipant {
  return {
    speakerLabel: null,
    isSpeaker: true,
    name: null,
    role: "sconosciuto",
    organization: null,
    phone: null,
    email: null,
    evidence: [],
    clientMatch: null,
    ...overrides,
  };
}

const LAWYER = participant({ speakerLabel: "Speaker 1", name: "Avv. Vincenzo Sapone", role: "avvocato_studio" });
const ROSSI = participant({
  speakerLabel: "Speaker 2",
  name: "Mario Rossi",
  role: "cliente",
  clientMatch: {
    clientId: "C-0001",
    displayName: "Mario Rossi",
    email: "mario.rossi@example.com",
    phone: null,
    matterIds: ["M-0002"],
    score: 0.9,
    matchedOn: "nome",
  },
});

function action(id: string, payload: ActionPayload): ProposedAction {
  return {
    id,
    origin: "modello",
    payload,
    confidence: 0.9,
    evidence: [],
    rationale: "Test",
    preselected: true,
    warnings: [],
  };
}

function proposal(participants: ProposalParticipant[], actions: ProposedAction[] = []): Proposal {
  return {
    id: RECORDING.id,
    recordingId: RECORDING.id,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: "da_revisionare",
    recording: {
      title: RECORDING.title,
      startedAt: RECORDING.startedAt,
      durationMs: RECORDING.durationMs,
      source: "plaud",
    },
    conversationType: "telefonata",
    summary: "Il cliente ha ricevuto un decreto ingiuntivo e conferisce l'incarico per l'opposizione.",
    participants,
    actions,
    doubts: [{ text: "Data esatta della notifica", evidence: [] }],
    warnings: [],
    extractor: { name: "fixture", model: null },
    executions: [],
  };
}

type Payload<T extends ActionPayload["type"]> = Extract<ActionPayload, { type: T }>;

const appointment = (overrides: Partial<Payload<"appuntamento">> = {}): Payload<"appuntamento"> => ({
  type: "appuntamento",
  title: "Appuntamento con Mario Rossi",
  status: "fissato",
  start: "2026-10-15T10:00",
  durationMinutes: null,
  location: null,
  mode: "in_studio",
  participants: ["Mario Rossi", "Avv. Vincenzo Sapone"],
  notes: "Portare il decreto ingiuntivo",
  ...overrides,
});

const engagement = (overrides: Partial<Payload<"incarico">> = {}): Payload<"incarico"> => ({
  type: "incarico",
  status: "conferito",
  clientName: "Mario Rossi",
  subject: "Opposizione a decreto ingiuntivo Edilnord",
  matterType: "civile",
  counterpart: "Edilnord S.r.l.",
  urgency: null,
  notes: null,
  ...overrides,
});

const fee: Payload<"accordo_economico"> = {
  type: "accordo_economico",
  description: "Compenso per l'opposizione",
  agreed: true,
  amount: 2500,
  currency: "EUR",
  basis: "forfait",
  hourlyRate: null,
  plusVatAndCpa: true,
  advanceAmount: 1250,
  paymentTerms: "50% alla firma del mandato",
};

let tmp: string;
let outboxDir: string;
let gestionaleFile: string;
let caseManagement: JsonCaseManagement;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "seguito-executors-"));
  outboxDir = join(tmp, "outbox");
  gestionaleFile = join(tmp, "gestionale.json");
  await writeFile(gestionaleFile, JSON.stringify(GESTIONALE));
  caseManagement = new JsonCaseManagement(gestionaleFile, { now: () => NOW });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Contesto di esecuzione; senza `approved` si intendono approvate tutte le azioni della proposta. */
function context(p: Proposal, studio: StudioProfile = STUDIO, approved?: string[]): ExecutionContext {
  const approvedActionIds = new Set(approved ?? p.actions.map((a) => a.id));
  return { proposal: p, recording: RECORDING, studio, outboxDir, caseManagement, now: NOW, approvedActionIds };
}

async function run(a: ProposedAction, ctx: ExecutionContext): Promise<ExecutionResult> {
  const executor = defaultExecutors().find((e) => e.canHandle(a));
  if (executor === undefined) throw new Error(`nessun esecutore per ${a.payload.type}`);
  return executor.execute(a, ctx);
}

async function artifactText(result: ExecutionResult, index = 0): Promise<string> {
  const path = result.artifacts[index]?.path;
  if (path == null) throw new Error("artefatto senza percorso");
  expect(path.startsWith("/")).toBe(false);
  expect(path).not.toContain("\\");
  return readFile(join(outboxDir, ...path.split("/")), "utf8");
}

/** Righe iCalendar logiche, con il testo riportato in chiaro. */
function icsLines(ics: string): string[] {
  return ics
    .replace(/\r\n /g, "")
    .split("\r\n")
    .map((l) => l.replace(/\\n/g, "\n").replace(/\\([,;\\])/g, "$1"));
}

function emlHeaders(eml: string): string {
  return eml.slice(0, eml.indexOf("\r\n\r\n")).replace(/\r\n[ \t]/g, " ");
}

function decodeHeader(value: string): string {
  const bytes = value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64: string) => Buffer.from(b64, "base64").toString("latin1"));
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/** Testo della prima parte text/plain (base64). */
function emlText(eml: string): string {
  const afterHeaders = eml.slice(eml.indexOf("\r\n\r\n") + 4);
  const multipart = /boundary="([^"]+)"/.exec(emlHeaders(eml));
  const section = multipart ? (afterHeaders.split(`--${multipart[1]}`)[1] ?? "") : `\r\n\r\n${afterHeaders}`;
  const b64 = section.slice(section.indexOf("\r\n\r\n") + 4).replace(/\s+/g, "");
  return Buffer.from(b64, "base64").toString("utf8").replace(/\r\n/g, "\n");
}

async function gestionale(): Promise<CaseManagementData> {
  return JSON.parse(await readFile(gestionaleFile, "utf8")) as CaseManagementData;
}

describe("appuntamenti", () => {
  test("fissato: evento .ics nella cartella della proposta", async () => {
    const a = action("a1", appointment());
    const result = await run(a, context(proposal([LAWYER, ROSSI], [a])));
    expect(result).toMatchObject({ actionId: "a1", status: "ok", executedAt: NOW.toISOString() });
    expect(result.message).toContain("giovedì 15 ottobre 2026");
    expect(result.artifacts).toEqual([
      {
        kind: "ics",
        label: "Evento: Appuntamento con Mario Rossi",
        path: "plaud-demo-rossi/a1-appuntamento-con-mario-rossi.ics",
        ref: null,
      },
    ]);
    const lines = icsLines(await artifactText(result));
    expect(lines).toContain("UID:plaud-demo-rossi-a1@seguito");
    expect(lines).toContain("DTSTART:20261015T080000Z");
    expect(lines).toContain("DTEND:20261015T090000Z");
    expect(lines).toContain("LOCATION:Studio Legale Sapone");
    expect(lines).toContain("TRIGGER:-P1D");
    expect(lines).toContain("TRIGGER:-PT60M");
    const description = lines.find((l) => l.startsWith("DESCRIPTION:")) ?? "";
    expect(description).toContain("Partecipanti: Mario Rossi, Avv. Vincenzo Sapone");
    expect(description).toContain("Sintesi della conversazione: Il cliente ha ricevuto un decreto ingiuntivo");
    expect(description).toContain("Note: Portare il decreto ingiuntivo");
    expect(description).toContain(
      "Generato da Seguito dalla registrazione di mercoledì 7 ottobre 2026 alle ore 09:30",
    );
  });

  test("fissato senza data valida: errore, nessun file", async () => {
    for (const start of [null, "giovedì prossimo"]) {
      const a = action("a1", appointment({ start }));
      const result = await run(a, context(proposal([ROSSI], [a])));
      expect(result.status).toBe("errore");
      expect(result.message).toMatch(/Data e ora dell'appuntamento mancanti o non valide/);
      expect(result.artifacts).toEqual([]);
    }
    await expect(readdir(outboxDir)).rejects.toThrow();
  });

  test("da fissare: bozza al cliente con il link di prenotazione", async () => {
    const a = action("a2", appointment({ status: "da_fissare", start: null }));
    const studio = { ...STUDIO, bookingLink: "https://cal.example/sapone" };
    const result = await run(a, context(proposal([LAWYER, ROSSI], [a]), studio));
    expect(result.status).toBe("ok");
    expect(result.artifacts[0]?.kind).toBe("eml");
    const eml = await artifactText(result);
    const headers = emlHeaders(eml);
    expect(headers).toContain("To: Mario Rossi <mario.rossi@example.com>");
    expect(headers).toContain("X-Unsent: 1");
    const subject = /^Subject: (.*)$/m.exec(headers)?.[1] ?? "";
    expect(decodeHeader(subject)).toBe("Appuntamento presso lo studio");
    const text = emlText(eml);
    expect(text).toContain("Gentile Mario Rossi,");
    expect(text).toContain(
      "facendo seguito alla nostra telefonata di mercoledì 7 ottobre 2026, Le scrivo per fissare l'appuntamento di cui abbiamo parlato.",
    );
    expect(text).not.toContain("Appuntamento con Mario Rossi");
    expect(text).toContain("può scegliere data e ora qui: https://cal.example/sapone");
    expect(text.endsWith(STUDIO.signature)).toBe(true);
  });

  test("da fissare senza cliente collegato né link: chiede le disponibilità, nessun destinatario", async () => {
    const a = action("a2", appointment({ status: "da_fissare", start: null, mode: "telefonico", participants: ["Paolo Verdi"] }));
    const verdi = participant({ name: "Paolo Verdi", role: "potenziale_cliente", email: "non è un indirizzo" });
    const result = await run(a, context(proposal([LAWYER, verdi], [a])));
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/senza destinatario/);
    const eml = await artifactText(result);
    expect(emlHeaders(eml)).not.toMatch(/^To:/m);
    const text = emlText(eml);
    expect(text).toContain("Gentile Paolo Verdi,");
    expect(text).toContain("La prego di indicarmi alcune date e fasce orarie");
    expect(text).toContain("Il colloquio si svolgerà telefonicamente.");
  });

  test("da fissare: usa l'email detta in chiamata se il cliente non è nel gestionale", async () => {
    const a = action("a2", appointment({ status: "da_fissare", start: null, participants: [] }));
    const verdi = participant({ name: "Paolo Verdi", role: "potenziale_cliente", email: "paolo.verdi@example.com" });
    const eml = await artifactText(await run(a, context(proposal([verdi], [a]))));
    expect(emlHeaders(eml)).toContain("To: Paolo Verdi <paolo.verdi@example.com>");
  });
});

describe("appuntamenti da fissare", () => {
  const toSchedule = (overrides: Partial<Payload<"appuntamento">> = {}) =>
    appointment({ status: "da_fissare", start: null, ...overrides });
  const clientEmail: Payload<"email"> = {
    type: "email",
    recipientName: "Mario Rossi",
    recipientEmail: "mario.rossi@example.com",
    recipientRole: "cliente",
    subject: "Documenti e prenotazione del primo incontro",
    body: "Gentile Sig. Rossi,\n\nper il primo incontro in studio può scegliere giorno e orario dal link.\n\nCordiali saluti.",
    purpose: "Documenti e prenotazione",
  };

  test("con la data indicata dall'avvocato: evento .ics, nessuna bozza", async () => {
    const a = action("a1", toSchedule({ start: "2026-10-20T15:00" }));
    const result = await run(a, context(proposal([LAWYER, ROSSI], [a])));
    expect(result.status).toBe("ok");
    expect(result.artifacts.map((x) => x.kind)).toEqual(["ics"]);
    expect(icsLines(await artifactText(result))).toContain("DTSTART:20261020T130000Z");
  });

  test("un'email approvata allo stesso cliente parla già dell'appuntamento: nessuna seconda bozza", async () => {
    const a = action("a1", toSchedule());
    const mail = action("a5", clientEmail);
    const p = proposal([LAWYER, ROSSI], [a, mail]);
    const result = await run(a, context(p, STUDIO, ["a1", "a5"]));
    expect(result.status).toBe("saltata");
    expect(result.message).toContain("«Documenti e prenotazione del primo incontro»");
    expect(result.message).toContain("«Data e ora»");
    expect(result.artifacts).toEqual([]);
    await expect(readdir(outboxDir)).rejects.toThrow();

    // Se l'email non è approvata, la bozza per fissare l'appuntamento serve.
    const alone = await run(a, context(p, STUDIO, ["a1"]));
    expect(alone.status).toBe("ok");
    expect(alone.artifacts[0]?.kind).toBe("eml");
  });

  test("appuntamento con un terzo: nessuna bozza al cliente", async () => {
    const a = action("a1", toSchedule({ participants: ["Geom. Luigi Bassi", "Avv. Vincenzo Sapone"] }));
    const result = await run(a, context(proposal([LAWYER, ROSSI], [a])));
    expect(result.status).toBe("saltata");
    expect(result.message).toMatch(/^Il cliente non partecipa all'appuntamento/);
    expect(result.artifacts).toEqual([]);
  });
});

describe("scadenze", () => {
  const deadline = (overrides: Partial<Payload<"scadenza">> = {}): Payload<"scadenza"> => ({
    type: "scadenza",
    title: "Opposizione a decreto ingiuntivo",
    date: "2026-11-11",
    time: null,
    kind: "processuale",
    legalBasis: "art. 641 c.p.c.",
    computation: "notifica 02/10/2026 + 40 giorni",
    notes: null,
    ...overrides,
  });

  test("giornata intera con promemoria a 7 giorni e 1 giorno", async () => {
    const a = action("a3", deadline());
    const result = await run(a, context(proposal([ROSSI], [a])));
    expect(result.status).toBe("ok");
    expect(result.artifacts[0]?.path).toBe("plaud-demo-rossi/a3-opposizione-a-decreto-ingiuntivo.ics");
    const lines = icsLines(await artifactText(result));
    expect(lines).toContain("SUMMARY:Scadenza: Opposizione a decreto ingiuntivo (da verificare)");
    expect(lines).toContain("DTSTART;VALUE=DATE:20261111");
    expect(lines).toContain("DTEND;VALUE=DATE:20261112");
    expect(lines).toContain("TRIGGER:-P7D");
    expect(lines).toContain("TRIGGER:-P1D");
    const description = lines.find((l) => l.startsWith("DESCRIPTION:")) ?? "";
    expect(description).toContain("Riferimento normativo: art. 641 c.p.c.");
    expect(description).toContain("Calcolo: notifica 02/10/2026 + 40 giorni");
    expect(description).toContain("Termine calcolato automaticamente: verificarne il calcolo.");
  });

  test("udienza già fissata: niente «calcolato automaticamente»; termini non processuali senza «da verificare»", async () => {
    const hearing = await run(action("a3", deadline({ computation: null, title: "Udienza" })), context(proposal([ROSSI])));
    const hearingLines = icsLines(await artifactText(hearing));
    expect(hearingLines).toContain("SUMMARY:Scadenza: Udienza (da verificare)");
    const description = hearingLines.find((l) => l.startsWith("DESCRIPTION:")) ?? "";
    expect(description).toContain("Data da verificare sul fascicolo.");
    expect(description).not.toContain("calcolato");

    const contract = await run(
      action("a4", deadline({ kind: "contrattuale", computation: null, legalBasis: null, title: "Pagamento" })),
      context(proposal([ROSSI])),
    );
    const contractLines = icsLines(await artifactText(contract));
    expect(contractLines).toContain("SUMMARY:Scadenza: Pagamento");
    expect(contractLines.find((l) => l.startsWith("DESCRIPTION:"))).not.toMatch(/verificar/);
  });

  test("con orario valido diventa un evento con ora", async () => {
    const a = action("a3", deadline({ time: "12:00" }));
    const result = await run(a, context(proposal([ROSSI], [a])));
    expect(icsLines(await artifactText(result))).toContain("DTSTART:20261111T110000Z");
    expect(result.message).toContain("ore 12:00");
  });

  test("data mancante o non valida: errore", async () => {
    for (const date of [null, "2026-11-31"]) {
      const result = await run(action("a3", deadline({ date })), context(proposal([ROSSI])));
      expect(result.status).toBe("errore");
      expect(result.message).toMatch(/Data della scadenza/);
    }
  });
});

describe("email", () => {
  const email = (recipientEmail: string | null): ActionPayload => ({
    type: "email",
    recipientName: "Mario Rossi",
    recipientEmail,
    recipientRole: "cliente",
    subject: "Documenti per l'opposizione al decreto ingiuntivo",
    body: "Gentile Sig. Rossi,\n\nLe ricordo i documenti da portare.\n\nCordiali saluti.",
    purpose: "Riepilogo documenti",
  });

  test("bozza con destinatario e firma", async () => {
    const result = await run(action("a4", email("mario.rossi@example.com")), context(proposal([ROSSI])));
    expect(result).toMatchObject({ status: "ok", message: "Bozza creata." });
    expect(result.artifacts[0]).toMatchObject({
      kind: "eml",
      label: "Bozza email: Documenti per l'opposizione al decreto ingiuntivo",
    });
    const eml = await artifactText(result);
    const headers = emlHeaders(eml);
    expect(headers).toContain('From: "Avv. Vincenzo Sapone" <avvocato@studio.example>');
    expect(headers).toContain("To: Mario Rossi <mario.rossi@example.com>");
    expect(emlText(eml)).toBe(
      "Gentile Sig. Rossi,\n\nLe ricordo i documenti da portare.\n\nCordiali saluti.\n\nAvv. Vincenzo Sapone\nStudio Legale Sapone",
    );
  });

  test("senza destinatario: bozza comunque creata", async () => {
    const result = await run(action("a4", email(null)), context(proposal([ROSSI])));
    expect(result).toMatchObject({
      status: "ok",
      message: "Bozza creata senza destinatario: aggiungerlo prima dell'invio.",
    });
    expect(emlHeaders(await artifactText(result))).not.toMatch(/^To:/m);
  });

  test("indirizzo non valido: l'eccezione arriva all'approvazione", async () => {
    await expect(run(action("a4", email("mario rossi")), context(proposal([ROSSI])))).rejects.toThrow(
      /Indirizzo email non valido/,
    );
  });
});

describe("invio della trascrizione", () => {
  test("bozza allo studio con riepilogo, trascrizione e allegato", async () => {
    const actions = [
      action("a1", appointment()),
      action("a2", fee),
      action("a3", { type: "invio_trascrizione", to: STUDIO.studioEmail }),
    ];
    const p = proposal([LAWYER, ROSSI], actions);
    p.warnings = [{ code: "COLLEGA_ART38", severity: "bloccante", message: "Avviso art. 38 di prova." }];
    const result = await run(actions[2] as ProposedAction, context(p));
    expect(result.status).toBe("ok");
    expect(result.message).toContain("segreteria@studio.example");
    const eml = await artifactText(result);
    const headers = emlHeaders(eml);
    expect(headers).toContain("To: segreteria@studio.example");
    const subject = /^Subject: (.*)$/m.exec(headers)?.[1] ?? "";
    expect(decodeHeader(subject)).toBe(
      "Trascrizione – Chiamata Mario Rossi – decreto ingiuntivo – mercoledì 7 ottobre 2026",
    );
    const text = emlText(eml);
    expect(text).toContain("SINTESI\nIl cliente ha ricevuto un decreto ingiuntivo");
    expect(text).toContain("- Mario Rossi (cliente) – Speaker 2 – nel gestionale: Mario Rossi");
    expect(text).toContain("- Appuntamento: Appuntamento con Mario Rossi – giovedì 15 ottobre 2026 alle ore 10:00");
    expect(text).toContain("- Accordo economico: Compenso per l'opposizione – € 2.500,00 oltre IVA e CPA (concordato)");
    expect(text).not.toContain("- Invio trascrizione");
    expect(text).toContain("AVVISI\n- Avviso art. 38 di prova.");
    expect(text).toContain("PUNTI DA CHIARIRE\n- Data esatta della notifica");
    const transcript =
      "[00:00] Speaker 1: Studio Sapone, buongiorno.\n[00:04] Speaker 2: Buongiorno avvocato, sono Mario Rossi.\n[12:34] Speaker 1: Ci vediamo giovedì alle dieci.";
    expect(text).toContain(`TRASCRIZIONE\n${transcript}`);
    expect(eml).toContain('Content-Disposition: attachment; filename="trascrizione.txt"');
    const attachmentB64 = eml.split('filename="trascrizione.txt"')[1]?.split("\r\n\r\n")[1]?.split("\r\n--")[0] ?? "";
    const attachment = Buffer.from(attachmentB64.replace(/\s+/g, ""), "base64").toString("utf8");
    expect(attachment.replace(/\r\n/g, "\n")).toContain(transcript);
  });
});

describe("gestionale", () => {
  test("incarico conferito: nuova pratica aperta e nota", async () => {
    const a = action("a1", engagement());
    const result = await run(a, context(proposal([LAWYER, ROSSI], [a])));
    expect(result.status).toBe("ok");
    expect(result.message).toContain(
      "Pratica 2026/005 «Opposizione a decreto ingiuntivo Edilnord» aperta per Mario Rossi.",
    );
    expect(result.artifacts).toEqual([
      {
        kind: "gestionale",
        label: "Nuova pratica 2026/005 – Opposizione a decreto ingiuntivo Edilnord",
        path: null,
        ref: "M-0003",
      },
      { kind: "gestionale", label: "Nota nella pratica 2026/005", path: null, ref: "N-0001" },
    ]);
    const data = await gestionale();
    const matter = data.matters.find((m) => m.id === "M-0003");
    expect(matter).toMatchObject({ clientId: "C-0001", status: "aperta", number: "2026/005" });
    expect(matter?.notes[0]).toMatchObject({
      author: "Seguito",
      kind: "incarico",
      sourceRecordingId: "plaud:demo-rossi",
    });
    expect(matter?.notes[0]?.text).toBe(
      [
        "Incarico: Opposizione a decreto ingiuntivo Edilnord – incarico conferito",
        "Cliente: Mario Rossi",
        "Materia: civile",
        "Controparte: Edilnord S.r.l.",
        "Fonte: registrazione «Chiamata Mario Rossi – decreto ingiuntivo» di mercoledì 7 ottobre 2026 alle ore 09:30",
      ].join("\n"),
    );

    // Stesso titolo (a meno di maiuscole e punteggiatura): nessuna pratica duplicata.
    const again = action("a9", engagement({ subject: "opposizione a decreto ingiuntivo, Edilnord" }));
    const second = await run(again, context(proposal([ROSSI], [again])));
    expect(second.artifacts.map((x) => x.ref)).toEqual(["N-0002"]);
    expect((await gestionale()).matters).toHaveLength(3);
  });

  test("accordo economico: nota sulla pratica attiva più recente del cliente", async () => {
    const p = proposal([ROSSI]);
    await run(action("a1", engagement()), context(p));
    const result = await run(action("a2", fee), context(p));
    expect(result).toMatchObject({ status: "ok", message: "Nota registrata nella pratica 2026/005 (Mario Rossi)." });
    expect(result.artifacts).toEqual([
      { kind: "gestionale", label: "Nota nella pratica 2026/005", path: null, ref: "N-0002" },
    ]);
    const note = (await gestionale()).matters.find((m) => m.id === "M-0003")?.notes[1];
    expect(note?.kind).toBe("accordo_economico");
    expect(note?.text).toContain("Importo: € 2.500,00 oltre IVA e CPA");
    expect(note?.text).toContain("Acconto: € 1.250,00");
  });

  test("documenti: nota sulla pratica aperta esistente", async () => {
    const neri = participant({
      name: "Laura Neri",
      role: "cliente",
      clientMatch: {
        clientId: "C-0002",
        displayName: "Laura Neri",
        email: null,
        phone: null,
        matterIds: ["M-0001"],
        score: 1,
        matchedOn: "email",
      },
    });
    const docs: ActionPayload = {
      type: "documenti",
      direction: "da_ricevere",
      items: ["Verbale di assemblea", "Perizia"],
      counterpartName: "Laura Neri",
      dueDate: "2026-10-16",
    };
    const result = await run(action("a1", docs), context(proposal([neri])));
    expect(result.artifacts[0]?.label).toBe("Nota nella pratica 2025/087");
    const note = (await gestionale()).matters.find((m) => m.id === "M-0001")?.notes[0];
    expect(note?.text).toContain(
      "Documenti: Documenti da ricevere da Laura Neri entro venerdì 16 ottobre 2026\n- Verbale di assemblea\n- Perizia",
    );
  });

  test("attività per un cliente senza pratiche attive: pratica «Da classificare»", async () => {
    const task: ActionPayload = {
      type: "attivita",
      description: "Verificare la data di notifica",
      assignee: null,
      dueDate: null,
    };
    const result = await run(action("a5", task), context(proposal([ROSSI])));
    expect(result.status).toBe("ok");
    const created = (await gestionale()).matters.find((m) => m.id === "M-0003");
    expect(created).toMatchObject({
      title: "Da classificare – Chiamata Mario Rossi – decreto ingiuntivo",
      status: "in_valutazione",
    });
    expect(created?.notes[0]?.kind).toBe("attivita");
  });

  test("nuovo cliente: creato dall'incarico, poi ritrovato dalle altre azioni", async () => {
    const verdi = participant({
      name: "Paolo Verdi",
      role: "potenziale_cliente",
      email: "paolo.verdi@example.com",
      phone: "+39 347 000 1111",
    });
    const p = proposal([LAWYER, verdi]);
    const result = await run(
      action("a1", engagement({ status: "in_valutazione", clientName: "Paolo Verdi", subject: "Sovraindebitamento" })),
      context(p),
    );
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(
      /^Nuovo cliente Paolo Verdi inserito nel gestionale\. Pratica 2026\/005 «Sovraindebitamento» creata in valutazione/,
    );
    expect(result.artifacts[0]).toEqual({
      kind: "gestionale",
      label: "Nuovo cliente: Paolo Verdi",
      path: null,
      ref: "C-0004",
    });
    const data = await gestionale();
    expect(data.clients.find((c) => c.id === "C-0004")).toEqual({
      id: "C-0004",
      kind: "persona_fisica",
      displayName: "Paolo Verdi",
      firstName: "Paolo",
      lastName: "Verdi",
      companyName: null,
      taxCode: null,
      vatNumber: null,
      email: "paolo.verdi@example.com",
      pec: null,
      phone: "+39 347 000 1111",
      address: null,
    });
    const followUp = await run(action("a2", { ...fee, agreed: false }), context(p));
    expect(followUp.artifacts[0]?.label).toBe("Nota nella pratica 2026/005");
  });

  test("cliente non individuato: errore per le azioni diverse dall'incarico, con l'indicazione di come procedere", async () => {
    const result = await run(action("a2", fee), context(proposal([LAWYER])));
    expect(result).toMatchObject({
      status: "errore",
      message:
        "Cliente non presente nel gestionale: approvare anche l'incarico (che crea l'anagrafica) " +
        "oppure registrare la nota manualmente.",
    });
  });

  test("cliente corretto nel campo «Cliente»: prevale sul collegamento per solo cognome", async () => {
    // Proposta meno recente: «Rossi» collegato a Mario Rossi per il solo cognome.
    const mrsRossi = participant({
      name: "Rossi",
      role: "potenziale_cliente",
      clientMatch: { ...(ROSSI.clientMatch as NonNullable<ProposalParticipant["clientMatch"]>), score: 0.6 },
    });
    const incarico = action("a1", engagement({ clientName: "Anna Rossi", subject: "Separazione giudiziale" }));
    const accordo = action("a2", fee);
    const p = proposal([LAWYER, mrsRossi], [incarico, accordo]);
    const result = await run(incarico, context(p));
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/^Nuovo cliente Anna Rossi inserito nel gestionale\. Pratica 2026\/005 «Separazione giudiziale» aperta per Anna Rossi\./);
    const followUp = await run(accordo, context(p));
    expect(followUp.message).toBe("Nota registrata nella pratica 2026/005 (Anna Rossi).");
    const data = await gestionale();
    expect(data.matters.filter((m) => m.clientId === "C-0001").flatMap((m) => m.notes)).toEqual([]);
  });

  test("nome dell'incarico compatibile con il cliente collegato in modo sicuro: stesso cliente", async () => {
    const byEmail = participant({
      name: "Rossi",
      role: "cliente",
      clientMatch: { ...(ROSSI.clientMatch as NonNullable<ProposalParticipant["clientMatch"]>), score: 1, matchedOn: "email" },
    });
    const result = await run(action("a1", engagement({ clientName: "Sig. Rossi" })), context(proposal([byEmail])));
    expect(result.message).toContain("aperta per Mario Rossi");
    expect((await gestionale()).clients).toHaveLength(3);
  });

  test("omonimo con nome diverso: non collegato al cliente sbagliato", async () => {
    const bruni = participant({ name: "Marco Bruni", role: "cliente" });
    const result = await run(action("a2", fee), context(proposal([bruni])));
    expect(result.status).toBe("errore");
  });

  test("incarico non conferito", async () => {
    const declined = engagement({ status: "non_conferito" });
    const unknown = await run(action("a1", { ...declined, clientName: "Giorgio Gialli" }), context(proposal([LAWYER])));
    expect(unknown.status).toBe("saltata");
    expect((await gestionale()).clients).toHaveLength(3);

    const bruni = participant({
      name: "Anna Bruni",
      role: "cliente",
      clientMatch: {
        clientId: "C-0003",
        displayName: "Anna Bruni",
        email: null,
        phone: null,
        matterIds: [],
        score: 0.9,
        matchedOn: "nome",
      },
    });
    const noMatters = await run(action("a1", { ...declined, clientName: "Anna Bruni" }), context(proposal([bruni])));
    expect(noMatters).toMatchObject({ status: "saltata" });
    expect(noMatters.message).toContain("Anna Bruni");

    // Con una pratica (anche chiusa) la nota va sull'ultima.
    const rossi = await run(action("a1", declined), context(proposal([ROSSI])));
    expect(rossi.artifacts).toEqual([
      { kind: "gestionale", label: "Nota nella pratica 2026/004", path: null, ref: "N-0001" },
    ]);
  });

  test("incarico senza alcun nome del cliente: errore", async () => {
    const result = await run(action("a1", engagement({ clientName: null })), context(proposal([LAWYER])));
    expect(result).toMatchObject({ status: "errore" });
    expect(result.message).toMatch(/Nome del cliente mancante/);
  });
});

describe("splitPersonName", () => {
  test("nome e cognome, particelle e titoli", () => {
    expect(splitPersonName("Paolo Verdi")).toEqual({ firstName: "Paolo", lastName: "Verdi" });
    expect(splitPersonName("Maria Grazia De Luca")).toEqual({ firstName: "Maria Grazia", lastName: "De Luca" });
    expect(splitPersonName("Sig. Mario D'Angelo")).toEqual({ firstName: "Mario", lastName: "D'Angelo" });
    expect(splitPersonName("Verdi")).toEqual({ firstName: null, lastName: "Verdi" });
  });
});
