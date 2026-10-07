import { describe, expect, test } from "vitest";
import {
  ProposalSchema,
  type ClientMatch,
  type ExtractedAction,
  type ExtractedParticipant,
  type Extraction,
  type Matter,
  type Proposal,
  type ProposedAction,
  type Recording,
  type Segment,
  type StudioProfile,
  type WarningCode,
} from "../src/domain/types.js";
import type { CaseManagement, ClientQuery } from "../src/enrich/case-management.js";
import { buildProposal, normalizeForMatch, resolveEvidence } from "../src/extract/postprocess.js";

const studio: StudioProfile = {
  studioName: "Studio Legale Sapone",
  lawyerName: "Avv. Vincenzo Sapone",
  lawyerEmail: "avvocato@studio.example",
  studioEmail: "segreteria@studio.example",
  timezone: "Europe/Rome",
  bookingLink: null,
  signature: "Avv. Vincenzo Sapone",
};

/** Mercoledì 7 ottobre 2026, 10:00 a Roma. */
const now = new Date("2026-10-07T08:00:00.000Z");

const segments: Segment[] = [
  { index: 0, startMs: 0, endMs: 3000, speaker: "Speaker 1", text: "Pronto, studio Sapone." },
  { index: 1, startMs: 3000, endMs: 7000, speaker: "Speaker 2", text: "Buongiorno avvocato, sono Mario Rossi." },
  { index: 2, startMs: 7000, endMs: 12000, speaker: "Speaker 1", text: "Ci vediamo giovedì 15 alle ore 15:00 in studio." },
  { index: 3, startMs: 12000, endMs: 16000, speaker: "Speaker 2", text: "Perfetto, porterò il decreto ingiuntivo." },
];

const recording: Recording = {
  id: "plaud:rec-1",
  source: "plaud",
  externalId: "rec-1",
  title: "Chiamata Rossi",
  startedAt: "2026-10-07T07:30:00.000Z",
  durationMs: 16000,
  segments,
  plaudSummary: null,
  fetchedAt: "2026-10-07T07:59:00.000Z",
};

const VERIFIED = [{ segment: 2, quote: "giovedì 15 alle ore 15:00" }];

const rossiMatch: ClientMatch = {
  clientId: "c1",
  displayName: "Mario Rossi",
  email: "mario.rossi@example.it",
  phone: null,
  matterIds: ["m1"],
  score: 0.92,
  matchedOn: "nome",
};

/** Gestionale finto: solo la ricerca dei clienti è usata dalla costruzione della proposta. */
class FakeCaseManagement implements CaseManagement {
  readonly name = "finto";
  readonly queries: ClientQuery[] = [];
  constructor(
    private readonly byName: Record<string, ClientMatch[]>,
    private readonly matterNumbers: Record<string, string[]> = {},
  ) {}
  async findClients(query: ClientQuery): Promise<ClientMatch[]> {
    this.queries.push(query);
    return this.byName[query.organization ?? ""] ?? this.byName[query.name ?? ""] ?? [];
  }
  getClient(): never {
    throw new Error("non usato");
  }
  createClient(): never {
    throw new Error("non usato");
  }
  async listMatters(clientId: string): Promise<Matter[]> {
    return (this.matterNumbers[clientId] ?? []).map((number, i) => ({
      id: `M-${i}`,
      clientId,
      number,
      title: "Pratica",
      status: "aperta",
      openedAt: "2026-01-01T00:00:00.000Z",
      notes: [],
    }));
  }
  createMatter(): never {
    throw new Error("non usato");
  }
  addMatterNote(): never {
    throw new Error("non usato");
  }
}

function participant(overrides: Partial<ExtractedParticipant>): ExtractedParticipant {
  return {
    speakerLabel: null,
    isSpeaker: false,
    name: null,
    role: "sconosciuto",
    organization: null,
    phone: null,
    email: null,
    evidence: [{ segment: 1, quote: "sono Mario Rossi" }],
    ...overrides,
  };
}

const lawyer = participant({ speakerLabel: "Speaker 1", isSpeaker: true, name: "Vincenzo Sapone", role: "avvocato_studio" });
const rossi = participant({ speakerLabel: "Speaker 2", isSpeaker: true, name: "Mario Rossi", role: "cliente" });

const common = { confidence: 0.9, evidence: VERIFIED, rationale: "Concordato in chiamata." };

function appointment(overrides: Partial<Extract<ExtractedAction, { type: "appuntamento" }>> = {}): ExtractedAction {
  return {
    type: "appuntamento",
    title: "Incontro in studio con Mario Rossi",
    status: "fissato",
    start: "2026-10-15T15:00",
    durationMinutes: 60,
    location: null,
    mode: "in_studio",
    participants: ["Mario Rossi"],
    notes: null,
    ...common,
    ...overrides,
  };
}

function deadline(overrides: Partial<Extract<ExtractedAction, { type: "scadenza" }>> = {}): ExtractedAction {
  return {
    type: "scadenza",
    title: "Opposizione a decreto ingiuntivo",
    date: "2026-11-11",
    time: null,
    kind: "contrattuale",
    legalBasis: null,
    computation: null,
    notes: null,
    ...common,
    ...overrides,
  };
}

function email(overrides: Partial<Extract<ExtractedAction, { type: "email" }>> = {}): ExtractedAction {
  return {
    type: "email",
    recipientName: "Mario Rossi",
    recipientEmail: null,
    recipientRole: "cliente",
    subject: "Conferma appuntamento",
    body: "Gentile Sig. Rossi,\nconfermo l'appuntamento.\nCordiali saluti.",
    purpose: "Confermare l'appuntamento.",
    ...common,
    ...overrides,
  };
}

const engagement: ExtractedAction = {
  type: "incarico",
  status: "conferito",
  clientName: "Mario Rossi",
  subject: "Opposizione a decreto ingiuntivo",
  matterType: "civile",
  counterpart: "Alfa S.r.l.",
  urgency: null,
  notes: null,
  ...common,
};

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    conversationType: "telefonata",
    summary: "Il Sig. Rossi fissa un appuntamento.",
    participants: [lawyer, rossi],
    actions: [appointment()],
    doubts: [],
    ...overrides,
  };
}

async function build(ext: Extraction, cm: CaseManagement = new FakeCaseManagement({ "Mario Rossi": [rossiMatch] })) {
  return buildProposal({
    recording,
    extraction: ext,
    studio,
    caseManagement: cm,
    extractor: { name: "fixture", model: null },
    now,
  });
}

async function single(action: ExtractedAction, ext: Partial<Extraction> = {}): Promise<ProposedAction> {
  const proposal = await build(extraction({ ...ext, actions: [action] }));
  return proposal.actions[0]!;
}

const codes = (a: ProposedAction): WarningCode[] => a.warnings.map((w) => w.code);
const severityOf = (a: ProposedAction, code: WarningCode) => a.warnings.find((w) => w.code === code)?.severity;

describe("normalizeForMatch", () => {
  test("toglie accenti, punteggiatura e maiuscole", () => {
    expect(normalizeForMatch("  Perché l'Avvocato è lì?! ")).toBe("perche l avvocato e li");
    expect(normalizeForMatch("€ 2.500,00")).toBe("2 500 00");
    expect(normalizeForMatch("...")).toBe("");
  });
});

describe("resolveEvidence", () => {
  test("verifica la citazione nel segmento indicato", () => {
    const [e] = resolveEvidence([{ segment: 1, quote: "SONO mario ROSSI" }], segments);
    expect(e).toEqual({ segment: 1, quote: "SONO mario ROSSI", startMs: 3000, speaker: "Speaker 2", verified: true });
  });

  test("accetta una citazione a cavallo con il segmento successivo", () => {
    const [e] = resolveEvidence([{ segment: 2, quote: "in studio. Perfetto, porterò" }], segments);
    expect(e?.verified).toBe(true);
  });

  test("respinge citazioni assenti, vuote o su segmenti inesistenti", () => {
    const resolved = resolveEvidence(
      [
        { segment: 1, quote: "sono Luigi Bianchi" },
        { segment: 1, quote: " ... " },
        { segment: 9, quote: "sono Mario Rossi" },
        { segment: 0, quote: "porterò il decreto" },
      ],
      segments,
    );
    expect(resolved.map((e) => e.verified)).toEqual([false, false, false, false]);
    expect(resolved[2]).toMatchObject({ startMs: null, speaker: null });
  });
});

describe("buildProposal", () => {
  test("struttura della proposta e azione di sistema in coda", async () => {
    const proposal = await build(
      extraction({ doubts: [{ text: "Cognome da confermare.", evidence: [{ segment: 1, quote: "Mario Rossi" }] }] }),
    );
    expect(() => ProposalSchema.parse(proposal)).not.toThrow();
    expect(proposal).toMatchObject<Partial<Proposal>>({
      id: "plaud:rec-1",
      recordingId: "plaud:rec-1",
      status: "da_revisionare",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      recording: { title: "Chiamata Rossi", startedAt: recording.startedAt, durationMs: 16000, source: "plaud" },
      conversationType: "telefonata",
      summary: "Il Sig. Rossi fissa un appuntamento.",
      extractor: { name: "fixture", model: null },
      executions: [],
      warnings: [],
    });
    expect(proposal.doubts[0]?.evidence[0]?.verified).toBe(true);
    expect(proposal.actions.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(proposal.actions[1]).toEqual({
      id: "a2",
      origin: "sistema",
      payload: { type: "invio_trascrizione", to: "segreteria@studio.example" },
      confidence: 1,
      evidence: [],
      rationale: "Archiviazione della trascrizione nella casella dello studio",
      preselected: true,
      warnings: [],
    });
  });

  test("il payload non contiene confidenza, evidenze e motivazione", async () => {
    const action = await single(appointment());
    expect(action.origin).toBe("modello");
    expect(action.payload).not.toHaveProperty("confidence");
    expect(action.payload).not.toHaveProperty("evidence");
    expect(action.payload).not.toHaveProperty("rationale");
    expect(action.rationale).toBe("Concordato in chiamata.");
    expect(action.evidence[0]).toMatchObject({ verified: true, speaker: "Speaker 1", startMs: 7000 });
  });

  test("collega i partecipanti al gestionale solo per i ruoli pertinenti e sopra soglia", async () => {
    const cm = new FakeCaseManagement({
      "Mario Rossi": [{ ...rossiMatch, score: 0.7 }, rossiMatch],
      "Luca Verdi": [{ ...rossiMatch, clientId: "c2", displayName: "Luca Verdi", score: 0.4 }],
    });
    const proposal = await build(
      extraction({
        participants: [
          lawyer,
          rossi,
          participant({ name: "Luca Verdi", role: "consulente", email: "verdi@example.it" }),
          participant({ name: "Alfa S.r.l.", role: "controparte" }),
          participant({ role: "potenziale_cliente" }),
        ],
      }),
      cm,
    );
    expect(proposal.participants.map((p) => p.clientMatch?.score ?? null)).toEqual([null, 0.92, null, null, null]);
    // La controparte è cercata solo per il controllo del conflitto di interessi, mai collegata.
    expect(cm.queries).toEqual([
      { name: "Mario Rossi", email: null, phone: null, organization: null },
      { name: "Luca Verdi", email: "verdi@example.it", phone: null, organization: null },
      { name: "Alfa S.r.l.", email: null, phone: null, organization: null },
    ]);
    expect(proposal.participants[1]?.evidence[0]?.verified).toBe(true);
  });

  describe("avvisi per azione e preselezione", () => {
    test("azione confermata e verificata: preselezionata, senza avvisi", async () => {
      const action = await single(appointment());
      expect(action.warnings).toEqual([]);
      expect(action.preselected).toBe(true);
    });

    test("evidenze assenti o non ritrovate", async () => {
      const none = await single(appointment({ evidence: [] }));
      expect(codes(none)).toEqual(["EVIDENZA_NON_VERIFICATA"]);
      expect(severityOf(none, "EVIDENZA_NON_VERIFICATA")).toBe("attenzione");
      expect(none.preselected).toBe(false);
      const wrong = await single(appointment({ evidence: [{ segment: 2, quote: "venerdì alle 18" }] }));
      expect(codes(wrong)).toEqual(["EVIDENZA_NON_VERIFICATA"]);
    });

    test("appuntamento fissato senza data, con data non valida o passata", async () => {
      const missing = await single(appointment({ start: null }));
      expect(codes(missing)).toEqual(["DATA_MANCANTE"]);
      expect(severityOf(missing, "DATA_MANCANTE")).toBe("attenzione");
      expect(missing.preselected).toBe(false);

      const toSchedule = await single(appointment({ status: "da_fissare", start: null }));
      expect(toSchedule.warnings).toEqual([]);

      const invalid = await single(appointment({ start: "15/10/2026 15:00" }));
      expect(codes(invalid)).toEqual(["DATA_NON_VALIDA"]);
      expect(severityOf(invalid, "DATA_NON_VALIDA")).toBe("attenzione");

      const past = await single(appointment({ start: "2026-10-07T09:30" }));
      expect(codes(past)).toEqual(["DATA_PASSATA"]);
      expect(past.preselected).toBe(false);

      const laterToday = await single(appointment({ start: "2026-10-07T10:30" }));
      expect(laterToday.warnings).toEqual([]);
    });

    test("scadenze: data mancante, non valida, passata e termine processuale", async () => {
      expect(codes(await single(deadline({ date: null })))).toEqual(["DATA_MANCANTE"]);
      expect(codes(await single(deadline({ date: "2026-02-30" })))).toEqual(["DATA_NON_VALIDA"]);
      expect(codes(await single(deadline({ date: "2026-10-06" })))).toEqual(["DATA_PASSATA"]);
      expect(codes(await single(deadline({ date: "2026-10-07" })))).toEqual([]);
      expect(codes(await single(deadline({ time: "25:00" })))).toEqual(["DATA_NON_VALIDA"]);

      // Il termine processuale resta segnalato ma è preselezionato: fuori dal calendario è il rischio maggiore.
      const procedural = await single(deadline({ kind: "processuale", computation: "notifica 02/10/2026 + 40 giorni" }));
      expect(codes(procedural)).toEqual(["TERMINE_DA_VERIFICARE"]);
      expect(severityOf(procedural, "TERMINE_DA_VERIFICARE")).toBe("attenzione");
      expect(procedural.warnings[0]?.message).toContain("Termine calcolato automaticamente");
      expect(procedural.warnings[0]?.message).toContain("verificarlo sul fascicolo e sul codice");
      expect(procedural.preselected).toBe(true);

      const hearing = await single(deadline({ kind: "processuale", computation: null, time: "09:30" }));
      expect(hearing.warnings[0]?.message).toMatch(/^Data riferita nella conversazione/);
      expect(hearing.warnings[0]?.message).not.toContain("calcolato");
      expect(hearing.preselected).toBe(true);

      const unverified = await single(deadline({ kind: "processuale", evidence: [] }));
      expect(unverified.preselected).toBe(false);
    });

    test("dueDate non valida su documenti e attività: solo informativa", async () => {
      const docs = await single({
        type: "documenti",
        direction: "da_ricevere",
        items: ["decreto ingiuntivo"],
        counterpartName: "Mario Rossi",
        dueDate: "entro venerdì",
        ...common,
      });
      expect(codes(docs)).toEqual(["DATA_NON_VALIDA"]);
      expect(severityOf(docs, "DATA_NON_VALIDA")).toBe("info");
      expect(docs.preselected).toBe(true);

      const task = await single({ type: "attivita", description: "Studiare il fascicolo", assignee: null, dueDate: "2026-10-09", ...common });
      expect(task.warnings).toEqual([]);
    });

    test("confidenza bassa, soglia di preselezione e limiti 0..1", async () => {
      const low = await single(appointment({ confidence: 0.5 }));
      expect(codes(low)).toEqual(["CONFIDENZA_BASSA"]);
      expect(severityOf(low, "CONFIDENZA_BASSA")).toBe("info");
      expect(low.preselected).toBe(false);

      const medium = await single(appointment({ confidence: 0.7 }));
      expect(medium.warnings).toEqual([]);
      expect(medium.preselected).toBe(false);

      expect((await single(appointment({ confidence: 0.75 }))).preselected).toBe(true);
      expect((await single(appointment({ confidence: 1.4 }))).confidence).toBe(1);
      expect((await single(appointment({ confidence: -0.2 }))).confidence).toBe(0);
    });

    test("incarico senza cliente nel gestionale", async () => {
      expect((await single(engagement)).warnings).toEqual([]);
      const unknown = await build(extraction({ actions: [engagement] }), new FakeCaseManagement({}));
      const action = unknown.actions[0]!;
      expect(codes(action)).toEqual(["CLIENTE_NON_TROVATO"]);
      expect(severityOf(action, "CLIENTE_NON_TROVATO")).toBe("info");
      expect(action.warnings[0]?.message).toBe(
        "Il cliente non risulta nel gestionale: all'approvazione verrà creata una nuova anagrafica.",
      );
      expect(action.preselected).toBe(true);
    });
  });

  describe("email: indirizzo del destinatario", () => {
    const payloadEmail = (a: ProposedAction) => (a.payload.type === "email" ? a.payload.recipientEmail : undefined);

    test("indirizzo detto in chiamata: conservato", async () => {
      const action = await single(email({ recipientEmail: "rossi@altro.it" }));
      expect(payloadEmail(action)).toBe("rossi@altro.it");
      expect(action.warnings).toEqual([]);
    });

    test("completato dal gestionale tramite il nome del destinatario", async () => {
      const action = await single(email({ recipientName: "Rossi" }));
      expect(payloadEmail(action)).toBe("mario.rossi@example.it");
      expect(action.warnings).toEqual([]);
      expect(action.preselected).toBe(true);
    });

    test("completato tramite il ruolo quando un solo cliente è nel gestionale", async () => {
      const action = await single(email({ recipientName: "Sig. Mario R.", recipientRole: "potenziale_cliente" }));
      expect(payloadEmail(action)).toBe("mario.rossi@example.it");
    });

    test("destinatario non nel gestionale: da completare", async () => {
      const action = await single(email({ recipientName: "Avv. Neri", recipientRole: "collega_avvocato" }));
      expect(payloadEmail(action)).toBeNull();
      expect(codes(action)).toEqual(["DATI_CLIENTE_MANCANTI"]);
      expect(severityOf(action, "DATI_CLIENTE_MANCANTI")).toBe("attenzione");
      expect(action.preselected).toBe(false);
    });

    test("ruolo cliente ma più clienti nel gestionale: nessuna scelta arbitraria", async () => {
      const bianchi = participant({ speakerLabel: "Speaker 3", isSpeaker: true, name: "Anna Bianchi", role: "cliente" });
      const cm = new FakeCaseManagement({
        "Mario Rossi": [rossiMatch],
        "Anna Bianchi": [{ ...rossiMatch, clientId: "c3", displayName: "Anna Bianchi", email: "anna@example.it" }],
      });
      const proposal = await build(
        extraction({ participants: [lawyer, rossi, bianchi], actions: [email({ recipientName: null })] }),
        cm,
      );
      expect(codes(proposal.actions[0]!)).toEqual(["DATI_CLIENTE_MANCANTI"]);
    });
  });

  describe("art. 38, comma 2, del Codice deontologico forense", () => {
    const colleague = participant({ speakerLabel: "Speaker 3", isSpeaker: true, name: "Paolo Neri", role: "collega_avvocato" });

    test("telefonata con un collega: avviso bloccante e nessuna preselezione", async () => {
      const proposal = await build(extraction({ participants: [lawyer, rossi, colleague] }));
      expect(proposal.warnings).toHaveLength(1);
      expect(proposal.warnings[0]).toMatchObject({ code: "COLLEGA_ART38", severity: "bloccante" });
      expect(proposal.warnings[0]?.message).toBe(
        "Conversazione telefonica con un collega: l'art. 38, comma 2, del Codice deontologico forense vieta di " +
          "registrare una conversazione telefonica con un collega. Valutare la cancellazione della registrazione. " +
          "Nessuna azione è stata preselezionata.",
      );
      expect(proposal.actions).toHaveLength(2);
      expect(proposal.actions.every((a) => !a.preselected)).toBe(true);
    });

    test("riunione con un collega: consenso di tutti i presenti e divieto se collegato al telefono o in vivavoce", async () => {
      const proposal = await build(extraction({ conversationType: "riunione_in_presenza", participants: [lawyer, colleague] }));
      expect(proposal.warnings[0]?.message).toBe(
        "Riunione con un collega: la registrazione è consentita solo con il consenso di tutti i presenti " +
          "(art. 38, comma 2, del Codice deontologico forense). Se il collega partecipava al telefono o in vivavoce, " +
          "vale il divieto previsto per le conversazioni telefoniche; anche far ascoltare la telefonata a terzi in " +
          "vivavoce senza avvisare il collega ha rilievo disciplinare (CNF, sentenza n. 7 del 2016). Verificare il " +
          "consenso e le modalità di partecipazione prima di utilizzarla. Nessuna azione è stata preselezionata.",
      );
      expect(proposal.actions.every((a) => !a.preselected)).toBe(true);
    });

    test("videochiamata: a due trattata come telefonata, con più partecipanti come riunione", async () => {
      const oneToOne = await build(extraction({ conversationType: "videochiamata", participants: [lawyer, colleague] }));
      expect(oneToOne.warnings[0]?.message).toMatch(
        /^Videochiamata a due con un collega: in via prudenziale va trattata come una conversazione telefonica/,
      );
      expect(oneToOne.warnings[0]?.message).toContain("vieta di registrare una conversazione telefonica");
      const group = await build(extraction({ conversationType: "videochiamata", participants: [lawyer, rossi, colleague] }));
      expect(group.warnings[0]?.message).toMatch(/^Videochiamata con un collega: la registrazione è consentita solo con il consenso/);
      expect(group.warnings[0]?.message).toContain("vivavoce");
      expect([oneToOne, group].every((p) => p.actions.every((a) => !a.preselected))).toBe(true);
    });

    test("tipo di conversazione non determinabile: messaggio combinato", async () => {
      const proposal = await build(extraction({ conversationType: "non_determinabile", participants: [lawyer, colleague] }));
      const message = proposal.warnings[0]?.message ?? "";
      expect(message).toContain("conversazione telefonica");
      expect(message).toContain("consenso");
      expect(proposal.actions.every((a) => !a.preselected)).toBe(true);
    });

    test("collega solo menzionato, non partecipante: nessun avviso", async () => {
      const mentioned = participant({ name: "Paolo Neri", role: "collega_avvocato" });
      const proposal = await build(extraction({ participants: [lawyer, rossi, mentioned] }));
      expect(proposal.warnings).toEqual([]);
      expect(proposal.actions.every((a) => a.preselected)).toBe(true);
    });
  });

  describe("collegamento al cliente: mai sul solo cognome", () => {
    const surnameOnly: ClientMatch = { ...rossiMatch, score: 0.6 };
    const mrsRossi = participant({ speakerLabel: "Speaker 2", isSpeaker: true, name: "Rossi", role: "potenziale_cliente" });

    test("partecipante «Rossi»: non collegato a Mario Rossi, incarico da verificare e non preselezionato", async () => {
      const cm = new FakeCaseManagement({ Rossi: [surnameOnly] });
      const proposal = await build(
        extraction({ participants: [lawyer, mrsRossi], actions: [{ ...engagement, clientName: "Rossi" }] }),
        cm,
      );
      expect(proposal.participants[1]?.clientMatch).toBeNull();
      const action = proposal.actions[0]!;
      expect(codes(action)).toEqual(["CLIENTE_DA_VERIFICARE"]);
      expect(severityOf(action, "CLIENTE_DA_VERIFICARE")).toBe("attenzione");
      expect(action.warnings[0]?.message).toContain("Mario Rossi");
      expect(action.warnings[0]?.message).toContain("campo «Cliente»");
      expect(action.preselected).toBe(false);
    });

    test("nome dell'incarico diverso dal cliente collegato: prevale il nome", async () => {
      const cm = new FakeCaseManagement({
        "Mario Rossi": [rossiMatch],
        "Anna Rossi": [{ ...rossiMatch, score: 0.5 }],
      });
      const proposal = await build(extraction({ actions: [{ ...engagement, clientName: "Anna Rossi" }] }), cm);
      expect(codes(proposal.actions[0]!)).toEqual(["CLIENTE_NON_TROVATO"]);
    });

    test("nessun indirizzo del gestionale per un cliente collegato solo per cognome", async () => {
      const cm = new FakeCaseManagement({ Rossi: [surnameOnly] });
      const proposal = await build(
        extraction({ participants: [lawyer, mrsRossi], actions: [email({ recipientName: "Sig.ra Rossi" })] }),
        cm,
      );
      const action = proposal.actions[0]!;
      expect(action.payload.type === "email" ? action.payload.recipientEmail : undefined).toBeNull();
      expect(codes(action)).toEqual(["DATI_CLIENTE_MANCANTI"]);
    });
  });

  describe("email: destinatari diversi dal cliente", () => {
    const recipientOf = (a: ProposedAction) => (a.payload.type === "email" ? a.payload.recipientEmail : undefined);

    test("«Dott. Grossi» non riceve l'indirizzo di Rossi (parole intere, solo ai clienti)", async () => {
      for (const recipientRole of ["consulente", "cliente"] as const) {
        const action = await single(email({ recipientName: "Dott. Grossi", recipientRole }));
        expect(recipientOf(action), recipientRole).toBeNull();
        expect(codes(action)).toContain("DATI_CLIENTE_MANCANTI");
        expect(action.preselected).toBe(false);
      }
      const rossini = await single(email({ recipientName: "Avv. Rossini", recipientRole: "collega_avvocato" }));
      expect(recipientOf(rossini)).toBeNull();
    });

    test("art. 41 CDF: email diretta alla controparte segnalata e non preselezionata", async () => {
      const action = await single(
        email({ recipientName: "Edilnord S.r.l.", recipientRole: "controparte", recipientEmail: "info@edilnord.example" }),
      );
      expect(codes(action)).toEqual(["CONTROPARTE_DIRETTA"]);
      expect(severityOf(action, "CONTROPARTE_DIRETTA")).toBe("attenzione");
      expect(action.warnings[0]?.message).toContain("art. 41 del Codice deontologico forense");
      expect(action.preselected).toBe(false);
    });

    test("riferimenti temporali relativi nel testo: avviso informativo", async () => {
      const action = await single(
        email({ body: "Gentile Sig. Rossi,\nfacendo seguito alla telefonata di questa mattina, Le confermo che domani…" }),
      );
      expect(codes(action)).toEqual(["RIFERIMENTO_TEMPORALE"]);
      expect(severityOf(action, "RIFERIMENTO_TEMPORALE")).toBe("info");
      expect(action.warnings[0]?.message).toContain("«questa mattina», «domani»");
      expect(action.preselected).toBe(true);
      expect((await single(email({ body: "Le confermo l'oggetto della pratica." }))).warnings).toEqual([]);
    });

    test("email non richiesta (confidenza fino a 0,75): non preselezionata", async () => {
      expect((await single(email({ confidence: 0.75 }))).preselected).toBe(false);
      expect((await single(email({ confidence: 0.8 }))).preselected).toBe(true);
    });
  });

  describe("art. 24 CDF: controparte che è cliente dello studio", () => {
    const ferretti: ClientMatch = {
      clientId: "C-0005",
      displayName: "Ferretti Arredamenti S.n.c.",
      email: null,
      phone: null,
      matterIds: ["M-0005"],
      score: 0.85,
      matchedOn: "organizzazione",
    };

    test("avviso sulla proposta e sull'incarico, che non è preselezionato", async () => {
      const cm = new FakeCaseManagement(
        { "Mario Rossi": [rossiMatch], "Ferretti Arredamenti S.n.c.": [ferretti] },
        { "C-0005": ["2026/063"] },
      );
      const counterpart = participant({ organization: "Ferretti Arredamenti S.n.c.", role: "controparte" });
      const proposal = await build(
        extraction({
          participants: [lawyer, rossi, counterpart],
          actions: [{ ...engagement, counterpart: "Ferretti Arredamenti S.n.c." }, appointment()],
        }),
        cm,
      );
      expect(proposal.warnings).toHaveLength(1);
      expect(proposal.warnings[0]).toMatchObject({ code: "CONFLITTO_INTERESSI", severity: "attenzione" });
      expect(proposal.warnings[0]?.message).toBe(
        "Possibile conflitto di interessi (art. 24 del Codice deontologico forense): la controparte " +
          "«Ferretti Arredamenti S.n.c.» potrebbe corrispondere a Ferretti Arredamenti S.n.c., cliente dello studio " +
          "(pratica 2026/063). Verificare prima di accettare l'incarico.",
      );
      const [incarico, appuntamento] = proposal.actions;
      expect(codes(incarico!)).toEqual(["CONFLITTO_INTERESSI"]);
      expect(incarico?.preselected).toBe(false);
      expect(appuntamento?.preselected).toBe(true);
    });

    test("la controparte coincide con il cliente collegato: nessun conflitto", async () => {
      const cm = new FakeCaseManagement({ "Mario Rossi": [rossiMatch] });
      const proposal = await build(extraction({ actions: [{ ...engagement, counterpart: "Mario Rossi" }] }), cm);
      expect(proposal.warnings).toEqual([]);
    });
  });

  test("nessuna azione estratta: avviso informativo e sola azione di sistema", async () => {
    const proposal = await build(extraction({ actions: [] }));
    expect(proposal.warnings).toEqual([
      { code: "NESSUNA_AZIONE", severity: "info", message: "Dalla conversazione non sono emerse azioni da proporre." },
    ]);
    expect(proposal.actions.map((a) => [a.id, a.payload.type])).toEqual([["a1", "invio_trascrizione"]]);
  });
});
