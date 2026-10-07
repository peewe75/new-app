import { describe, expect, test } from "vitest";
import { buildIcsEvent, foldLine } from "../src/actions/ics.js";

const TZ = "Europe/Rome";
const NOW = new Date("2026-10-07T08:00:00.000Z");

function physicalLines(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  return ics.slice(0, -2).split("\r\n");
}

/** Righe logiche (dopo l'unfolding RFC 5545). */
function logicalLines(ics: string): string[] {
  return ics.replace(/\r\n /g, "").slice(0, -2).split("\r\n");
}

describe("buildIcsEvent", () => {
  test("evento con orario: struttura, UTC e promemoria", () => {
    const ics = buildIcsEvent({
      uid: "plaud-abc-a1@seguito",
      title: "Appuntamento Mario Rossi",
      description: "Opposizione a decreto ingiuntivo",
      location: "Studio Legale Sapone",
      start: "2026-10-15T10:00",
      timezone: TZ,
      alarmsMinutesBefore: [1440, 60, 90],
      now: NOW,
    });
    expect(ics).not.toMatch(/[^\r]\n/);
    const lines = logicalLines(ics);
    expect(lines.slice(0, 6)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Seguito//Studio Legale//IT",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
    ]);
    expect(lines).toContain("UID:plaud-abc-a1@seguito");
    expect(lines).toContain("DTSTAMP:20261007T080000Z");
    expect(lines).toContain("DTSTART:20261015T080000Z");
    expect(lines).toContain("DTEND:20261015T090000Z");
    expect(lines).toContain("SUMMARY:Appuntamento Mario Rossi");
    expect(lines).toContain("LOCATION:Studio Legale Sapone");
    expect(lines.filter((l) => l === "BEGIN:VALARM")).toHaveLength(3);
    expect(lines.filter((l) => l === "ACTION:DISPLAY")).toHaveLength(3);
    expect(lines).toContain("TRIGGER:-P1D");
    expect(lines).toContain("TRIGGER:-PT60M");
    expect(lines).toContain("TRIGGER:-PT90M");
    expect(lines.slice(-2)).toEqual(["END:VEVENT", "END:VCALENDAR"]);
  });

  test("ora solare e durata personalizzata", () => {
    const ics = buildIcsEvent({
      uid: "x@seguito",
      title: "Udienza",
      start: "2026-11-11T09:30",
      durationMinutes: 90,
      timezone: TZ,
      now: NOW,
    });
    const lines = logicalLines(ics);
    expect(lines).toContain("DTSTART:20261111T083000Z");
    expect(lines).toContain("DTEND:20261111T100000Z");
    expect(lines.some((l) => l.startsWith("DESCRIPTION"))).toBe(false);
    expect(lines.some((l) => l.startsWith("LOCATION"))).toBe(false);
  });

  test("evento di un giorno intero, anche a fine anno", () => {
    const lines = logicalLines(
      buildIcsEvent({
        uid: "s@seguito",
        title: "Scadenza: opposizione",
        start: null,
        allDayDate: "2026-12-31",
        timezone: TZ,
        alarmsMinutesBefore: [10080, 1440],
        now: NOW,
      }),
    );
    expect(lines).toContain("DTSTART;VALUE=DATE:20261231");
    expect(lines).toContain("DTEND;VALUE=DATE:20270101");
    expect(lines).toContain("TRIGGER:-P7D");
    expect(lines).toContain("TRIGGER:-P1D");
  });

  test("protegge i caratteri speciali del testo", () => {
    const ics = buildIcsEvent({
      uid: "e@seguito",
      title: "Rossi; Bianchi, Verdi",
      description: "Riga 1\nRiga 2\r\nC:\\cartella",
      start: "2026-10-15T10:00",
      timezone: TZ,
      now: NOW,
    });
    const lines = logicalLines(ics);
    expect(lines).toContain("SUMMARY:Rossi\\; Bianchi\\, Verdi");
    expect(lines).toContain("DESCRIPTION:Riga 1\\nRiga 2\\nC:\\\\cartella");
  });

  test("piega le righe lunghe senza spezzare i caratteri UTF-8", () => {
    const description = "Opposizione è già depositata — € 2.500,00 «più» IVA. ".repeat(12);
    const ics = buildIcsEvent({
      uid: "f@seguito",
      title: "Termine",
      description,
      start: "2026-10-15T10:00",
      timezone: TZ,
      now: NOW,
    });
    const lines = physicalLines(ics);
    for (const line of lines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      expect(line).not.toContain("�");
    }
    expect(lines.filter((l) => l.startsWith(" ")).length).toBeGreaterThan(3);
    const unfolded = logicalLines(ics).find((l) => l.startsWith("DESCRIPTION:"));
    expect(unfolded).toBe(`DESCRIPTION:${description.replace(/,/g, "\\,")}`);
  });

  test("foldLine: limite esatto di 75 ottetti con caratteri multibyte", () => {
    const line = `X:${"€".repeat(40)}`; // 2 + 120 ottetti
    const parts = foldLine(line).split("\r\n");
    expect(parts.map((p) => Buffer.byteLength(p, "utf8")).every((n) => n <= 75)).toBe(true);
    expect(parts[0]).toBe(`X:${"€".repeat(24)}`); // 2 + 72 = 74: il 25° "€" sforerebbe
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(line);
    expect(foldLine("BREVE:ok")).toBe("BREVE:ok");
  });

  test("rifiuta date non valide", () => {
    expect(() => buildIcsEvent({ uid: "u", title: "t", start: "2026-02-30T10:00", timezone: TZ, now: NOW })).toThrow(
      /non valide/,
    );
    expect(() => buildIcsEvent({ uid: "u", title: "t", start: null, timezone: TZ, now: NOW })).toThrow(/data valida/);
    expect(() =>
      buildIcsEvent({ uid: "u", title: "t", start: "2026-10-15T10:00", durationMinutes: 0, timezone: TZ, now: NOW }),
    ).toThrow(/Durata/);
  });
});
