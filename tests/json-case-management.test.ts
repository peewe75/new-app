import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CaseManagementData, Client } from "../src/domain/types.js";
import { JsonCaseManagement } from "../src/enrich/json-case-management.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seguito-gestionale-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function person(id: string, firstName: string, lastName: string, extra: Partial<Client> = {}): Client {
  return {
    id,
    kind: "persona_fisica",
    displayName: `${firstName} ${lastName}`,
    firstName,
    lastName,
    companyName: null,
    taxCode: null,
    vatNumber: null,
    email: null,
    pec: null,
    phone: null,
    address: null,
    ...extra,
  };
}

function company(id: string, name: string): Client {
  return {
    ...person(id, "", ""),
    kind: "persona_giuridica",
    displayName: name,
    firstName: null,
    lastName: null,
    companyName: name,
  };
}

const SAMPLE: CaseManagementData = {
  clients: [
    person("C-0001", "Mario", "Rossi", { email: "Mario.Rossi@example.com", phone: "+39 333 123 4567" }),
    person("C-0002", "Laura", "Neri"),
    company("C-0003", "Bianchi Costruzioni S.p.A."),
    person("C-0004", "Niccolò", "Dell'Acqua"),
    person("C-0007", "Luigi", "Verdi"),
  ],
  matters: [
    {
      id: "M-0001",
      clientId: "C-0002",
      number: "2025/087",
      title: "Neri c/ Condominio Via Manzoni 12 – infiltrazioni",
      status: "aperta",
      openedAt: "2025-05-10T08:00:00.000Z",
      notes: [
        {
          id: "N-0003",
          at: "2025-05-10T08:00:00.000Z",
          author: "Avv. Sapone",
          kind: "nota",
          text: "Apertura",
          sourceRecordingId: null,
        },
      ],
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

async function withSample(
  options: ConstructorParameters<typeof JsonCaseManagement>[1] = {},
): Promise<JsonCaseManagement> {
  const file = join(dir, "gestionale.json");
  await writeFile(file, JSON.stringify(SAMPLE));
  return new JsonCaseManagement(file, options);
}

describe("JsonCaseManagement: ricerca clienti", () => {
  test("email esatta senza distinzione di maiuscole", async () => {
    const cm = await withSample();
    const [best] = await cm.findClients({ email: " mario.rossi@EXAMPLE.com " });
    expect(best).toMatchObject({ clientId: "C-0001", score: 1, matchedOn: "email", matterIds: ["M-0002"] });
    expect(best?.email).toBe("Mario.Rossi@example.com");
  });

  test("telefono: ultime 9 cifre", async () => {
    const cm = await withSample();
    const [best] = await cm.findClients({ phone: "0039 333-1234567" });
    expect(best).toMatchObject({ clientId: "C-0001", score: 0.95, matchedOn: "telefono" });
    expect(await cm.findClients({ phone: "333 765 4321" })).toEqual([]);
  });

  test("nome e cognome, con titoli e accenti", async () => {
    const cm = await withSample();
    expect((await cm.findClients({ name: "Sig. Mario Rossi" }))[0]).toMatchObject({
      clientId: "C-0001",
      score: 0.9,
      matchedOn: "nome",
    });
    expect((await cm.findClients({ name: "dott. niccolo dell'acqua" }))[0]).toMatchObject({
      clientId: "C-0004",
      score: 0.9,
    });
    expect((await cm.findClients({ name: "Sig.ra Neri" }))[0]).toMatchObject({ clientId: "C-0002", score: 0.6 });
  });

  test("stesso cognome ma nome diverso: candidato debole", async () => {
    const cm = await withSample();
    const matches = await cm.findClients({ name: "Paolo Verdi" });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ clientId: "C-0007", score: 0.5 });
    expect(await cm.findClients({ name: "Paolo Gialli" })).toEqual([]);
  });

  test("società: tutte le parole della ragione sociale", async () => {
    const cm = await withSample();
    expect((await cm.findClients({ organization: "Bianchi Costruzioni SpA" }))[0]).toMatchObject({
      clientId: "C-0003",
      score: 0.85,
      matchedOn: "organizzazione",
    });
    // La collega Avv. Giulia Bianchi non va confusa con la società.
    expect(await cm.findClients({ name: "Avv. Giulia Bianchi", organization: "Studio Legale Bianchi" })).toEqual([]);
  });

  test("ordinamento per punteggio e soglia 0,5", async () => {
    const cm = await withSample();
    const matches = await cm.findClients({ name: "Rossi", email: "laura.neri@example.com", phone: "333 123 4567" });
    expect(matches.map((m) => [m.clientId, m.score])).toEqual([["C-0001", 0.95]]);
    expect(await cm.findClients({})).toEqual([]);
  });
});

describe("JsonCaseManagement: scritture", () => {
  test("file mancante: dati vuoti, creato alla prima scrittura con permessi riservati", async () => {
    const file = join(dir, "sub", "gestionale.json");
    const cm = new JsonCaseManagement(file, { now: () => new Date("2026-10-07T08:00:00.000Z") });
    expect(await cm.findClients({ name: "Mario Rossi" })).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
    const { id: _unused, ...input } = person("x", "Paolo", "Verdi");
    const client = await cm.createClient(input);
    expect(client.id).toBe("C-0001");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8")) as CaseManagementData;
    expect(saved.clients[0]?.displayName).toBe("Paolo Verdi");
  });

  test("id progressivi e numero di pratica per anno", async () => {
    const cm = await withSample({ now: () => new Date("2026-10-07T08:00:00.000Z") });
    const client = await cm.createClient({
      kind: "persona_fisica",
      displayName: "Paolo Verdi",
      firstName: "Paolo",
      lastName: "Verdi",
      companyName: null,
      taxCode: null,
      vatNumber: null,
      email: "paolo.verdi@example.com",
      pec: null,
      phone: null,
      address: null,
    });
    expect(client.id).toBe("C-0008");
    const matter = await cm.createMatter({
      clientId: client.id,
      title: " Sovraindebitamento ",
      status: "in_valutazione",
    });
    expect(matter).toMatchObject({
      id: "M-0003",
      number: "2026/005",
      title: "Sovraindebitamento",
      status: "in_valutazione",
      openedAt: "2026-10-07T08:00:00.000Z",
      notes: [],
    });
    const note = await cm.addMatterNote(matter.id, {
      author: "Seguito",
      kind: "incarico",
      text: "Prima nota",
      sourceRecordingId: "plaud:x",
    });
    expect(note).toEqual({
      id: "N-0004",
      at: "2026-10-07T08:00:00.000Z",
      author: "Seguito",
      kind: "incarico",
      text: "Prima nota",
      sourceRecordingId: "plaud:x",
    });
    expect((await cm.listMatters(client.id))[0]?.notes).toEqual([note]);
    expect(await cm.getClient("C-0008")).toEqual(client);
    expect(await cm.getClient("C-9999")).toBeNull();
    expect((await cm.findClients({ email: "paolo.verdi@example.com" }))[0]?.matterIds).toEqual(["M-0003"]);
  });

  test("il numero di pratica riparte con l'anno nuovo (fuso dello studio)", async () => {
    const cm = await withSample({ now: () => new Date("2026-12-31T23:30:00.000Z") });
    const matter = await cm.createMatter({ clientId: "C-0002", title: "Nuova", status: "aperta" });
    expect(matter.number).toBe("2027/001");
  });

  test("errori su riferimenti inesistenti e file non valido", async () => {
    const cm = await withSample();
    await expect(cm.createMatter({ clientId: "C-0999", title: "X", status: "aperta" })).rejects.toThrow(
      /Cliente C-0999/,
    );
    await expect(
      cm.addMatterNote("M-0999", { author: "Seguito", kind: "nota", text: "x", sourceRecordingId: null }),
    ).rejects.toThrow(/Pratica M-0999/);
    const bad = join(dir, "rotto.json");
    await writeFile(bad, JSON.stringify({ clients: [{ id: 1 }], matters: [] }));
    await expect(new JsonCaseManagement(bad).findClients({ name: "x" })).rejects.toThrow(/non è valido/);
  });

  test("scritture concorrenti serializzate, anche tra istanze diverse", async () => {
    const file = join(dir, "gestionale.json");
    await writeFile(file, JSON.stringify(SAMPLE));
    const a = new JsonCaseManagement(file);
    const b = new JsonCaseManagement(file);
    const notes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).addMatterNote("M-0001", {
          author: "Seguito",
          kind: "nota",
          text: `n${i}`,
          sourceRecordingId: null,
        }),
      ),
    );
    expect(new Set(notes.map((n) => n.id)).size).toBe(20);
    const matters = await a.listMatters("C-0002");
    expect(matters[0]?.notes).toHaveLength(21);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
