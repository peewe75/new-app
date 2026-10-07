import { describe, expect, test } from "vitest";
import { buildEml, isEmailAddress, type EmlMessage } from "../src/actions/eml.js";

function message(overrides: Partial<EmlMessage> = {}): EmlMessage {
  return {
    from: { name: "Avv. Vincenzo Sapone", email: "avvocato@studio.example" },
    to: [{ name: "Mario Rossi", email: "mario.rossi@example.com" }],
    subject: "Documenti per l'opposizione",
    text: "Gentile Sig. Rossi,\nLe invio l'elenco.\n\nCordiali saluti",
    date: new Date("2026-10-07T07:30:00.000Z"),
    messageId: "abc-123@seguito.local",
    ...overrides,
  };
}

function split(eml: string): { headers: string; body: string } {
  const at = eml.indexOf("\r\n\r\n");
  return { headers: eml.slice(0, at), body: eml.slice(at + 4) };
}

function headerValue(headers: string, name: string): string | undefined {
  const unfolded = headers.replace(/\r\n[ \t]/g, " ");
  return unfolded
    .split("\r\n")
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    ?.slice(name.length + 1)
    .trim();
}

/** Decodifica minima delle encoded-word RFC 2047 (base64). */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64: string) => Buffer.from(b64, "base64").toString("latin1"))
    .replace(/[\s\S]*/, (s) => Buffer.from(s, "latin1").toString("utf8"));
}

describe("buildEml", () => {
  test("intestazioni di una bozza semplice", () => {
    const eml = buildEml(message());
    expect(eml).not.toMatch(/[^\r]\n/);
    const { headers, body } = split(eml);
    expect(headerValue(headers, "From")).toBe('"Avv. Vincenzo Sapone" <avvocato@studio.example>');
    expect(headerValue(headers, "To")).toBe("Mario Rossi <mario.rossi@example.com>");
    expect(headerValue(headers, "Subject")).toBe("Documenti per l'opposizione");
    expect(headerValue(headers, "Date")).toBe("Wed, 07 Oct 2026 07:30:00 +0000");
    expect(headerValue(headers, "Message-ID")).toBe("<abc-123@seguito.local>");
    expect(headerValue(headers, "MIME-Version")).toBe("1.0");
    expect(headerValue(headers, "X-Unsent")).toBe("1");
    expect(headerValue(headers, "Content-Type")).toBe("text/plain; charset=utf-8");
    expect(headerValue(headers, "Content-Transfer-Encoding")).toBe("base64");
    const lines = body.trimEnd().split("\r\n");
    expect(lines.every((l) => l.length <= 76)).toBe(true);
    expect(Buffer.from(lines.join(""), "base64").toString("utf8")).toBe(
      "Gentile Sig. Rossi,\r\nLe invio l'elenco.\r\n\r\nCordiali saluti",
    );
  });

  test("senza destinatari omette To", () => {
    const { headers } = split(buildEml(message({ to: [] })));
    expect(headerValue(headers, "To")).toBeUndefined();
  });

  test("oggetto e nomi non ASCII codificati (RFC 2047), parole brevi", () => {
    const subject =
      "Trascrizione – Chiamata Mario Rossi – decreto ingiuntivo – mercoledì 7 ottobre 2026 – più dettagli";
    const eml = buildEml(
      message({
        subject,
        to: [
          { name: "Niccolò Dell'Acqua", email: "niccolo@example.com" },
          { name: null, email: "segreteria@studio.example" },
        ],
      }),
    );
    const { headers } = split(eml);
    for (const line of headers.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    const rawSubject = headerValue(headers, "Subject") ?? "";
    expect(rawSubject).toMatch(/^=\?UTF-8\?B\?/);
    for (const word of rawSubject.split(" ")) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeWords(rawSubject)).toBe(subject);
    const to = headerValue(headers, "To") ?? "";
    expect(to).toMatch(/=\?UTF-8\?B\?.+\?= <niccolo@example\.com>, segreteria@studio\.example$/);
    expect(decodeWords(to.split(" <")[0] ?? "")).toBe("Niccolò Dell'Acqua");
  });

  test("nomi con caratteri speciali tra virgolette", () => {
    const { headers } = split(
      buildEml(message({ to: [{ name: 'Rossi, Mario "Mariolino"', email: "m@example.com" }] })),
    );
    expect(headerValue(headers, "To")).toBe('"Rossi, Mario \\"Mariolino\\"" <m@example.com>');
  });

  test("allegati: multipart/mixed con nome RFC 2231 se non ASCII", () => {
    const transcript = "[00:00] Speaker 1: Buongiorno, è lo studio?\n[00:04] Speaker 2: Sì.";
    const eml = buildEml(
      message({
        attachments: [
          { filename: "trascrizione.txt", contentType: "text/plain; charset=utf-8", content: transcript },
          { filename: "verità.txt", contentType: "text/plain; charset=utf-8", content: "x" },
        ],
      }),
    );
    const { headers, body } = split(eml);
    const boundary = /boundary="([^"]+)"/.exec(headerValue(headers, "Content-Type") ?? "")?.[1];
    expect(boundary).toBeDefined();
    expect(headerValue(headers, "Content-Type")).toMatch(/^multipart\/mixed; boundary="=_seguito_[0-9a-f]{32}"$/);
    const parts = body.split(`--${boundary}`);
    expect(parts).toHaveLength(5); // preambolo vuoto, 3 parti, chiusura "--"
    expect(parts[4]?.startsWith("--")).toBe(true);
    const attachment = parts[2] ?? "";
    expect(attachment).toContain('Content-Disposition: attachment; filename="trascrizione.txt"');
    expect(attachment).toContain('Content-Type: text/plain; charset=utf-8; name="trascrizione.txt"');
    const encoded = attachment.split("\r\n\r\n")[1]?.trim().split("\r\n").join("") ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(transcript.replace(/\n/g, "\r\n"));
    expect(parts[3]).toContain("Content-Disposition: attachment; filename*=UTF-8''verit%C3%A0.txt");
    // Il boundary è casuale.
    expect(
      buildEml(message({ attachments: [{ filename: "a.txt", contentType: "text/plain", content: "a" }] })),
    ).not.toContain(boundary);
  });

  test("rifiuta l'header injection", () => {
    expect(() => buildEml(message({ subject: "Ciao\r\nBcc: spia@example.com" }))).toThrow(/interruzione di riga/);
    expect(() => buildEml(message({ to: [{ name: "Mario\nBcc: x@example.com", email: "m@example.com" }] }))).toThrow(
      /interruzione di riga/,
    );
    expect(() => buildEml(message({ to: [{ name: null, email: "m@example.com\r\nBcc: x@example.com" }] }))).toThrow(
      /interruzione di riga/,
    );
    expect(() => buildEml(message({ from: { name: "Avv.\rX", email: "a@b.it" } }))).toThrow(/interruzione di riga/);
    expect(() => buildEml(message({ messageId: "a@b\r\nX: y" }))).toThrow(/interruzione di riga/);
    expect(() =>
      buildEml(message({ attachments: [{ filename: "a\r\n.txt", contentType: "text/plain", content: "" }] })),
    ).toThrow(/interruzione di riga/);
  });

  test("rifiuta indirizzi e identificativi non validi", () => {
    expect(() => buildEml(message({ to: [{ name: null, email: "mario rossi at example.com" }] }))).toThrow(
      /Indirizzo email non valido/,
    );
    expect(() => buildEml(message({ messageId: "senza-chiocciola" }))).toThrow(/Identificativo/);
    expect(isEmailAddress("paolo.verdi@example.com")).toBe(true);
    expect(isEmailAddress("paolo verdi@example.com")).toBe(false);
  });

  test("oggetto ASCII lungo piegato sugli spazi", () => {
    const subject = Array.from({ length: 20 }, (_, i) => `parola${i}`).join(" ");
    const { headers } = split(buildEml(message({ subject })));
    for (const line of headers.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(headerValue(headers, "Subject")).toBe(subject);
  });
});
