import { describe, expect, test } from "vitest";
import {
  formatDuration,
  formatItalianDate,
  formatTimestamp,
  isLocalDate,
  isLocalDateTime,
  localDateOf,
  localDateTimeOf,
  zonedLocalToUtc,
} from "../src/domain/time.js";

const TZ = "Europe/Rome";

describe("time", () => {
  test("valida date locali", () => {
    expect(isLocalDate("2026-10-15")).toBe(true);
    expect(isLocalDate("2026-02-30")).toBe(false);
    expect(isLocalDateTime("2026-10-15T10:00")).toBe(true);
    expect(isLocalDateTime("2026-10-15T24:00")).toBe(false);
    expect(isLocalDateTime("2026-10-15")).toBe(false);
  });

  test("converte ora locale di Roma in UTC (ora legale e solare)", () => {
    expect(zonedLocalToUtc("2026-10-15T10:00", TZ).toISOString()).toBe("2026-10-15T08:00:00.000Z");
    expect(zonedLocalToUtc("2026-11-11T10:00", TZ).toISOString()).toBe("2026-11-11T09:00:00.000Z");
    expect(zonedLocalToUtc("2026-11-11", TZ).toISOString()).toBe("2026-11-10T23:00:00.000Z");
  });

  test("gestisce i cambi d'ora", () => {
    // 29/03/2026 alle 02:30 non esiste: si va avanti.
    expect(zonedLocalToUtc("2026-03-29T02:30", TZ).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // 25/10/2026 alle 02:30 si ripete: prima occorrenza (ancora ora legale, UTC+2).
    expect(zonedLocalToUtc("2026-10-25T02:30", TZ).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  test("ricava data e ora locali", () => {
    const d = new Date("2026-10-07T22:30:00Z");
    expect(localDateOf(d, TZ)).toBe("2026-10-08");
    expect(localDateTimeOf(d, TZ)).toBe("2026-10-08T00:30");
  });

  test("formatta", () => {
    expect(formatItalianDate("2026-10-15")).toBe("giovedì 15 ottobre 2026");
    expect(formatTimestamp(754_000)).toBe("12:34");
    expect(formatTimestamp(3_754_000)).toBe("1:02:34");
    expect(formatDuration(2_520_000)).toBe("42 min");
    expect(formatDuration(3_599_000)).toBe("1 h 00 min");
    expect(formatDuration(null)).toBe("—");
  });
});
