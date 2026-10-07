/**
 * Bozza email in formato .eml (RFC 5322 + MIME, UTF-8). L'intestazione
 * "X-Unsent: 1" fa aprire il file come bozza modificabile in Outlook e Apple Mail.
 */
import { randomBytes } from "node:crypto";

export interface EmlAddress {
  name: string | null;
  email: string;
}

export interface EmlAttachment {
  filename: string;
  /** Es. "text/plain; charset=utf-8". */
  contentType: string;
  content: string;
}

export interface EmlMessage {
  from: { name: string; email: string };
  to: EmlAddress[];
  subject: string;
  text: string;
  date: Date;
  messageId: string;
  attachments?: EmlAttachment[];
}

const CRLF = "\r\n";
const MAX_HEADER_LINE = 78;
/** Byte per encoded-word: 36 byte -> 48 caratteri base64 -> parola di 60 caratteri. */
const ENCODED_WORD_BYTES = 36;
const BASE64_LINE = 76;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const NAME_SPECIALS = /[()<>[\]:;@\\,."]/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;
const MESSAGE_ID = /^[^\s<>@]+@[^\s<>@]+$/;
const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(\s*;[\x20-\x7e]*)?$/;

/** Controllo essenziale di un indirizzo email (nessuno spazio, una sola "@"). */
export function isEmailAddress(value: string): boolean {
  return EMAIL.test(value.trim());
}

export function buildEml(msg: EmlMessage): string {
  rejectLineBreaks(msg);
  const attachments = msg.attachments ?? [];
  const headers = [foldHeader("From", formatAddress(msg.from))];
  if (msg.to.length > 0) headers.push(foldHeader("To", msg.to.map(formatAddress).join(", ")));
  headers.push(
    foldHeader("Subject", encodeUnstructured(msg.subject.replace(/\s+/g, " ").trim())),
    `Date: ${formatDate(msg.date)}`,
    `Message-ID: ${formatMessageId(msg.messageId)}`,
    "MIME-Version: 1.0",
    "X-Unsent: 1",
  );
  if (attachments.length === 0) {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    return [...headers, "", base64Lines(toCrlf(msg.text))].join(CRLF) + CRLF;
  }
  const boundary = `=_seguito_${randomBytes(16).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [textPart(msg.text), ...attachments.map(attachmentPart)];
  const body = parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF);
  return [...headers, "", body, `--${boundary}--`].join(CRLF) + CRLF;
}

/** Nessun valore di intestazione può contenere interruzioni di riga (header injection). */
function rejectLineBreaks(msg: EmlMessage): void {
  const values: Array<[string, string]> = [
    ["mittente", msg.from.name],
    ["mittente", msg.from.email],
    ...msg.to.flatMap(
      (a): Array<[string, string]> => [
        ["destinatario", a.name ?? ""],
        ["destinatario", a.email],
      ],
    ),
    ["oggetto", msg.subject],
    ["identificativo del messaggio", msg.messageId],
    ...(msg.attachments ?? []).flatMap(
      (a): Array<[string, string]> => [
        ["nome dell'allegato", a.filename],
        ["tipo dell'allegato", a.contentType],
      ],
    ),
  ];
  for (const [field, value] of values) {
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`Intestazione email non valida: il campo ${field} contiene un'interruzione di riga.`);
    }
  }
}

function formatAddress(address: EmlAddress): string {
  const email = address.email.trim();
  if (!isEmailAddress(email)) throw new Error(`Indirizzo email non valido: «${address.email}».`);
  const name = address.name?.trim() ?? "";
  return name === "" ? email : `${formatDisplayName(name)} <${email}>`;
}

function formatDisplayName(name: string): string {
  if (!PRINTABLE_ASCII.test(name)) return encodeWords(name).join(" ");
  return NAME_SPECIALS.test(name) ? quote(name) : name;
}

/** Testo libero (oggetto): encoded-word RFC 2047 se non è ASCII. */
function encodeUnstructured(text: string): string {
  return PRINTABLE_ASCII.test(text) ? text : encodeWords(text).join(" ");
}

/** Encoded-word base64 brevi, spezzate senza dividere i caratteri UTF-8. */
function encodeWords(text: string): string[] {
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk !== "" && Buffer.byteLength(chunk + char, "utf8") > ENCODED_WORD_BYTES) {
      words.push(encodeWord(chunk));
      chunk = "";
    }
    chunk += char;
  }
  if (chunk !== "") words.push(encodeWord(chunk));
  return words;
}

function encodeWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** Piega l'intestazione sugli spazi oltre 78 caratteri. */
function foldHeader(name: string, value: string): string {
  const lines: string[] = [];
  let current = `${name}:`;
  let hasWord = false;
  for (const word of value.split(" ")) {
    // Si va a capo solo prima di una parola, mai lasciando righe di soli spazi.
    if (hasWord && word !== "" && current.length + 1 + word.length > MAX_HEADER_LINE) {
      lines.push(current);
      current = "";
    }
    current += ` ${word}`;
    hasWord ||= word !== "";
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Es. "Wed, 07 Oct 2026 07:30:00 +0000". */
function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Data del messaggio non valida.");
  return date.toUTCString().replace(/ GMT$/, " +0000");
}

function formatMessageId(id: string): string {
  const bare = id.startsWith("<") && id.endsWith(">") ? id.slice(1, -1) : id;
  if (!MESSAGE_ID.test(bare)) throw new Error(`Identificativo del messaggio non valido: «${id}».`);
  return `<${bare}>`;
}

function textPart(text: string): string {
  return [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(toCrlf(text)),
  ].join(CRLF);
}

function attachmentPart(attachment: EmlAttachment): string {
  const { filename, contentType } = attachment;
  if (filename.trim() === "") throw new Error("Nome dell'allegato mancante.");
  if (!CONTENT_TYPE.test(contentType)) throw new Error(`Tipo dell'allegato non valido: «${contentType}».`);
  const ascii = PRINTABLE_ASCII.test(filename);
  const disposition = ascii
    ? `attachment; filename=${quote(filename)}`
    : `attachment; filename*=UTF-8''${encodeRfc2231(filename)}`;
  const content = contentType.toLowerCase().startsWith("text/") ? toCrlf(attachment.content) : attachment.content;
  return [
    `Content-Type: ${contentType}${ascii ? `; name=${quote(filename)}` : ""}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}`,
    "",
    base64Lines(content),
  ].join(CRLF);
}

/** Valore di parametro RFC 2231: UTF-8 con percent-encoding. */
function encodeRfc2231(value: string): string {
  return encodeURIComponent(value).replace(/[*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF);
}

function base64Lines(content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return (encoded.match(new RegExp(`.{1,${BASE64_LINE}}`, "g")) ?? []).join(CRLF);
}
