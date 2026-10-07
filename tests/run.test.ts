import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ActionExecutor, ExecutionContext } from "../src/actions/executor.js";
import { ApprovalValidationError, ProposalStateError, approveProposal, discardProposal } from "../src/actions/run.js";
import type {
  ActionPayload,
  ApprovalRequest,
  Proposal,
  ProposedAction,
  Recording,
  StudioProfile,
} from "../src/domain/types.js";
import { JsonCaseManagement } from "../src/enrich/json-case-management.js";

const NOW = new Date("2026-10-07T08:00:00.000Z");
const LATER = new Date("2026-10-07T09:00:00.000Z");

const STUDIO: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone",
};

const RECORDING: Recording = {
  id: "plaud:demo-rossi",
  source: "plaud",
  externalId: "demo-rossi",
  title: "Chiamata Mario Rossi – decreto ingiuntivo",
  startedAt: "2026-10-07T07:30:00.000Z",
  durationMs: 840_000,
  segments: [{ index: 0, startMs: 0, endMs: 4_000, speaker: "Speaker 1", text: "Studio Sapone, buongiorno." }],
  plaudSummary: null,
  fetchedAt: "2026-10-07T08:00:00.000Z",
};

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

const appointment: ActionPayload = {
  type: "appuntamento",
  title: "Appuntamento con Mario Rossi",
  status: "fissato",
  start: "2026-10-15T10:00",
  durationMinutes: 60,
  location: null,
  mode: "in_studio",
  participants: [],
  notes: null,
};

const engagement: ActionPayload = {
  type: "incarico",
  status: "conferito",
  clientName: "Mario Rossi",
  subject: "Opposizione a decreto ingiuntivo",
  matterType: null,
  counterpart: null,
  urgency: null,
  notes: null,
};

const email: ActionPayload = {
  type: "email",
  recipientName: "Mario Rossi",
  recipientEmail: null,
  recipientRole: "cliente",
  subject: "Documenti",
  body: "Gentile Sig. Rossi, ...",
  purpose: "Riepilogo",
};

function proposal(overrides: Partial<Proposal> = {}): Proposal {
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
    summary: "Sintesi",
    participants: [],
    actions: [
      action("a1", appointment),
      action("a2", email),
      action("a3", engagement),
      action("a4", { type: "invio_trascrizione", to: STUDIO.studioEmail }),
    ],
    doubts: [],
    warnings: [],
    extractor: { name: "fixture", model: null },
    executions: [],
    ...overrides,
  };
}

interface Call {
  id: string;
  payload: ActionPayload;
  contextPayload: ActionPayload | undefined;
}

/** Esecutore finto: registra le chiamate; il comportamento per id è configurabile. */
function fakeExecutor(calls: Call[], behaviour: Record<string, () => never> = {}): ActionExecutor {
  return {
    name: "finto",
    canHandle: (a) => a.payload.type !== "documenti",
    async execute(a: ProposedAction, ctx: ExecutionContext) {
      calls.push({
        id: a.id,
        payload: a.payload,
        contextPayload: ctx.proposal.actions.find((x) => x.id === a.id)?.payload,
      });
      behaviour[a.id]?.();
      return { actionId: a.id, executedAt: ctx.now.toISOString(), status: "ok", message: "Fatto", artifacts: [] };
    },
  };
}

let tmp: string;
let caseManagement: JsonCaseManagement;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "seguito-run-"));
  caseManagement = new JsonCaseManagement(join(tmp, "gestionale.json"), { now: () => NOW });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function approve(p: Proposal, request: ApprovalRequest, executors?: ActionExecutor[], now = NOW): Promise<Proposal> {
  return approveProposal({
    proposal: p,
    request,
    recording: RECORDING,
    studio: STUDIO,
    outboxDir: join(tmp, "outbox"),
    caseManagement,
    now,
    ...(executors === undefined ? {} : { executors }),
  });
}

describe("approveProposal: regole", () => {
  test("non approvabile se scartata o se ogni azione è già stata eseguita", async () => {
    const done = proposal({ status: "eseguita" });
    const allExecuted = {
      ...done,
      executions: done.actions.map((a) => ({
        actionId: a.id,
        executedAt: NOW.toISOString(),
        status: "ok" as const,
        message: "Fatto.",
        artifacts: [],
      })),
    };
    for (const closed of [proposal({ status: "scartata" }), allExecuted]) {
      const error = await approve(closed, { actionIds: ["a1"] }, [fakeExecutor([])]).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ProposalStateError);
      expect((error as Error).name).toBe("ProposalStateError");
      expect((error as Error).message).toMatch(/non può essere approvata/);
    }
  });

  test("azioni inesistenti o nessuna azione", async () => {
    const error = await approve(proposal(), { actionIds: ["a1", "a9", "zz"] }, [fakeExecutor([])]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApprovalValidationError);
    expect((error as Error).name).toBe("ApprovalValidationError");
    expect((error as Error).message).toBe("Azioni inesistenti nella proposta: a9, zz.");
    await expect(approve(proposal(), { actionIds: [] }, [fakeExecutor([])])).rejects.toThrow(
      /Nessuna azione selezionata/,
    );
  });

  test("registrazione diversa dalla proposta", async () => {
    await expect(
      approveProposal({
        proposal: proposal(),
        request: { actionIds: ["a1"] },
        recording: { ...RECORDING, id: "plaud:altra" },
        studio: STUDIO,
        outboxDir: tmp,
        caseManagement,
        now: NOW,
        executors: [fakeExecutor([])],
      }),
    ).rejects.toBeInstanceOf(ApprovalValidationError);
  });

  test("modifiche non ammesse", async () => {
    const cases: Array<[ApprovalRequest, RegExp]> = [
      [{ actionIds: ["a1"], edits: { a2: { subject: "Altro" } } }, /non è tra quelle approvate/],
      [{ actionIds: ["a1"], edits: { a7: { subject: "Altro" } } }, /azione inesistente: a7/],
      [
        { actionIds: ["a1"], edits: { a1: { colore: "rosso", luogo: "x" } } },
        /Campi inesistenti per l'azione a1 \(Appuntamento\): colore, luogo/,
      ],
      [
        { actionIds: ["a1"], edits: { a1: { type: "scadenza" } } },
        /tipo dell'azione a1 \(Appuntamento\) non è modificabile/,
      ],
      [
        { actionIds: ["a1"], edits: { a1: { durationMinutes: "sessanta", status: "boh" } } },
        /Valori non validi per l'azione a1 \(Appuntamento\) nei campi: (status, durationMinutes|durationMinutes, status)/,
      ],
      [{ actionIds: ["a1"], edits: { a1: { ["__proto__"]: { x: 1 } } } }, /Campi inesistenti/],
    ];
    for (const [request, message] of cases) {
      const calls: Call[] = [];
      const error = await approve(proposal(), request, [fakeExecutor(calls)]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApprovalValidationError);
      expect((error as Error).message).toMatch(message);
      expect(calls).toEqual([]);
    }
  });

  test("modifiche valide: applicate al payload, l'originale resta intatto", async () => {
    const original = proposal();
    const snapshot = structuredClone(original);
    const calls: Call[] = [];
    const result = await approve(
      original,
      {
        actionIds: ["a1", "a2"],
        edits: { a1: { start: "2026-10-16T11:30", location: null }, a2: { recipientEmail: "mario.rossi@example.com" } },
      },
      [fakeExecutor(calls)],
    );
    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
    expect(result.actions[0]?.payload).toMatchObject({
      start: "2026-10-16T11:30",
      location: null,
      title: "Appuntamento con Mario Rossi",
    });
    expect(result.actions[1]?.payload).toMatchObject({ recipientEmail: "mario.rossi@example.com" });
    expect(calls.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(calls[0]?.payload).toMatchObject({ start: "2026-10-16T11:30" });
    expect(calls[0]?.contextPayload).toEqual(calls[0]?.payload);
  });
});

describe("approveProposal: esecuzione", () => {
  test("in sequenza, incarichi per primi; esiti aggiunti e stato eseguita", async () => {
    const calls: Call[] = [];
    const result = await approve(proposal(), { actionIds: ["a4", "a1", "a3", "a1"] }, [fakeExecutor(calls)]);
    expect(calls.map((c) => c.id)).toEqual(["a3", "a1", "a4"]);
    expect(result.executions.map((e) => [e.actionId, e.status])).toEqual([
      ["a3", "ok"],
      ["a1", "ok"],
      ["a4", "ok"],
    ]);
    expect(result.status).toBe("eseguita");
    expect(result.updatedAt).toBe(NOW.toISOString());
  });

  test("errori: messaggi in italiano senza dettagli tecnici, stato eseguita in parte", async () => {
    const calls: Call[] = [];
    const executor = fakeExecutor(calls, {
      a1: () => {
        throw new Error("Data e ora dell'evento non valide.");
      },
      a2: () => {
        throw Object.assign(new Error("EACCES: permission denied, open '/segreto/outbox/x.eml'"), { code: "EACCES" });
      },
      a3: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'x')");
      },
    });
    const result = await approve(proposal(), { actionIds: ["a1", "a2", "a3", "a4"] }, [executor]);
    const byId = Object.fromEntries(result.executions.map((e) => [e.actionId, e]));
    expect(byId.a1).toMatchObject({ status: "errore", message: "Data e ora dell'evento non valide.", artifacts: [] });
    expect(byId.a2?.message).toBe(
      "Errore di sistema durante l'esecuzione: permessi insufficienti sulla cartella o sul file.",
    );
    expect(byId.a3?.message).toBe("Errore imprevisto durante l'esecuzione dell'azione.");
    expect(byId.a4?.status).toBe("ok");
    expect(JSON.stringify(result.executions)).not.toMatch(/segreto|TypeError|at /);
    expect(result.status).toBe("eseguita_parzialmente");
  });

  test("azione senza esecutore", async () => {
    const p = proposal({
      actions: [
        action("a1", {
          type: "documenti",
          direction: "da_ricevere",
          items: ["Contratto"],
          counterpartName: null,
          dueDate: null,
        }),
      ],
    });
    const result = await approve(p, { actionIds: ["a1"] }, [fakeExecutor([])]);
    expect(result.executions[0]).toMatchObject({
      status: "errore",
      message: "Nessun esecutore disponibile per questo tipo di azione.",
    });
    expect(result.status).toBe("eseguita_parzialmente");
  });

  test("nuova approvazione dopo un'esecuzione parziale: le azioni riuscite non si ripetono", async () => {
    const failing = fakeExecutor([], {
      a2: () => {
        throw new Error("Indirizzo email non valido: «mario».");
      },
    });
    const first = await approve(proposal(), { actionIds: ["a1", "a2"] }, [failing]);
    expect(first.status).toBe("eseguita_parzialmente");

    const calls: Call[] = [];
    await expect(
      approve(
        first,
        { actionIds: ["a1", "a2"], edits: { a1: { title: "Nuovo titolo" } } },
        [fakeExecutor(calls)],
        LATER,
      ),
    ).rejects.toThrow(/già stata eseguita/);

    const second = await approve(
      first,
      { actionIds: ["a1", "a2"], edits: { a2: { recipientEmail: "mario.rossi@example.com" } } },
      [fakeExecutor(calls)],
      LATER,
    );
    expect(calls.map((c) => c.id)).toEqual(["a2"]);
    expect(second.executions.slice(2)).toEqual([
      { actionId: "a1", executedAt: LATER.toISOString(), status: "saltata", message: "Già eseguita", artifacts: [] },
      { actionId: "a2", executedAt: LATER.toISOString(), status: "ok", message: "Fatto", artifacts: [] },
    ]);
    expect(second.executions).toHaveLength(4);
    expect(second.status).toBe("eseguita");
    expect(second.updatedAt).toBe(LATER.toISOString());
    // Le azioni non ancora eseguite restano approvabili anche a proposta eseguita.
    const third = await approve(second, { actionIds: ["a3"] }, [fakeExecutor(calls)], LATER);
    expect(calls.map((c) => c.id)).toEqual(["a2", "a3"]);
    expect(third.status).toBe("eseguita");
  });

  test("un errore di un'approvazione precedente, non ancora risolto, lascia la proposta eseguita in parte", async () => {
    const failing = fakeExecutor([], {
      a1: () => {
        throw new Error("Data e ora dell'appuntamento mancanti o non valide.");
      },
    });
    const first = await approve(proposal(), { actionIds: ["a1", "a4"] }, [failing]);
    expect(first.status).toBe("eseguita_parzialmente");

    // Seconda approvazione della sola email: l'appuntamento resta in errore.
    const second = await approve(first, { actionIds: ["a2"] }, [fakeExecutor([])], LATER);
    expect(second.status).toBe("eseguita_parzialmente");

    // Corretto e rieseguito, la proposta risulta eseguita.
    const third = await approve(second, { actionIds: ["a1"] }, [fakeExecutor([])], LATER);
    expect(third.status).toBe("eseguita");
  });

  test("modifiche coerenti: data a un appuntamento da fissare, data corretta di una scadenza", async () => {
    const toSchedule = action("a1", { ...appointment, status: "da_fissare", start: null } as ActionPayload);
    const deadline = action("a2", {
      type: "scadenza",
      title: "Opposizione a decreto ingiuntivo",
      date: "2026-11-11",
      time: null,
      kind: "processuale",
      legalBasis: "art. 641 c.p.c.",
      computation: "notifica il 02/10/2026 + 40 giorni = 11/11/2026",
      notes: "Data riferita dal cliente.",
    });
    const calls: Call[] = [];
    const result = await approve(
      proposal({ actions: [toSchedule, deadline] }),
      { actionIds: ["a1", "a2"], edits: { a1: { start: "2026-10-20T15:00" }, a2: { date: "2026-11-10" } } },
      [fakeExecutor(calls)],
    );
    expect(result.actions[0]?.payload).toMatchObject({ status: "fissato", start: "2026-10-20T15:00" });
    expect(result.actions[1]?.payload).toMatchObject({
      date: "2026-11-10",
      computation: null,
      notes:
        "Data riferita dal cliente.\nData corretta dall'avvocato: il calcolo originario " +
        "(«notifica il 02/10/2026 + 40 giorni = 11/11/2026») non è più valido.",
    });
    expect(calls.map((c) => c.payload)).toEqual(result.actions.map((a) => a.payload));

    // Solo l'orario cambiato: il calcolo resta valido.
    const timeOnly = await approve(
      proposal({ actions: [deadline] }),
      { actionIds: ["a2"], edits: { a2: { time: "12:00" } } },
      [fakeExecutor([])],
    );
    expect(timeOnly.actions[0]?.payload).toMatchObject({ computation: "notifica il 02/10/2026 + 40 giorni = 11/11/2026" });
  });

  test("le azioni approvate sono indicate agli esecutori", async () => {
    let seen: string[] = [];
    const recorder: ActionExecutor = {
      name: "registra",
      canHandle: () => true,
      async execute(a, ctx) {
        seen = [...ctx.approvedActionIds].sort();
        return { actionId: a.id, executedAt: ctx.now.toISOString(), status: "ok", message: "Fatto", artifacts: [] };
      },
    };
    await approve(proposal(), { actionIds: ["a2", "a1"] }, [recorder]);
    expect(seen).toEqual(["a1", "a2"]);
  });

  test("con gli esecutori predefiniti: file nell'outbox e pratica nel gestionale", async () => {
    const p = proposal({
      participants: [
        {
          speakerLabel: "Speaker 2",
          isSpeaker: true,
          name: "Mario Rossi",
          role: "cliente",
          organization: null,
          phone: null,
          email: "mario.rossi@example.com",
          evidence: [],
          clientMatch: null,
        },
      ],
    });
    const result = await approve(p, { actionIds: ["a1", "a2", "a3", "a4"] });
    expect(result.executions.map((e) => [e.actionId, e.status])).toEqual([
      ["a3", "ok"],
      ["a1", "ok"],
      ["a2", "ok"],
      ["a4", "ok"],
    ]);
    expect(result.status).toBe("eseguita");
    const ics = result.executions.find((e) => e.actionId === "a1")?.artifacts[0]?.path ?? "";
    expect(await readFile(join(tmp, "outbox", ics), "utf8")).toContain("DTSTART:20261015T080000Z");
    const data = JSON.parse(await readFile(join(tmp, "gestionale.json"), "utf8")) as {
      clients: Array<{ displayName: string }>;
    };
    expect(data.clients.map((c) => c.displayName)).toEqual(["Mario Rossi"]);
  });
});

describe("discardProposal", () => {
  test("scarta solo le proposte da revisionare, senza modificare l'originale", () => {
    const original = proposal();
    const discarded = discardProposal(original, LATER);
    expect(discarded.status).toBe("scartata");
    expect(discarded.updatedAt).toBe(LATER.toISOString());
    expect(original.status).toBe("da_revisionare");
    expect(() => discardProposal(discarded, LATER)).toThrow(ProposalStateError);
    expect(() => discardProposal(proposal({ status: "eseguita_parzialmente" }), LATER)).toThrow(/da revisionare/);
  });
});

describe("file del gestionale assente", () => {
  test("viene creato alla prima scrittura", async () => {
    const result = await approve(proposal(), { actionIds: ["a3"] });
    expect(result.executions[0]?.status).toBe("ok");
    expect(JSON.parse(await readFile(join(tmp, "gestionale.json"), "utf8"))).toMatchObject({
      clients: [{ displayName: "Mario Rossi" }],
    });
  });
});
