/**
 * An Outlook `.msg` file as searchable text (#1409).
 *
 * A mail saved from Outlook onto a share is often the only record of an offer,
 * an order confirmation or a complaint, and what a reader searches for sits in
 * its headers as much as in its body. So the text the index stores starts with
 * a header block — subject, sender, recipients, date, attachment names — and
 * then the body.
 *
 * Parsed with `@kenjiuno/msgreader` (Apache-2.0, pure JS). It runs inside the
 * fenced reader child (`xlsx-isolated.ts`, op `msg`): the parser walks an
 * untrusted Compound File and decompresses RTF, and a file built to exhaust
 * memory must take down that child, not the server.
 *
 * What is deliberately NOT indexed:
 * - BCC recipients. A blind copy is the sender's decision that the other
 *   recipients must not see the name; the index is read by people who were
 *   never on the mail.
 * - Attachment contents. The names are listed, so a search for the file name
 *   finds the mail; the files themselves would need a citation target inside
 *   a mail, which no viewer offers. Save an attachment next to the mail to
 *   have it indexed as a document of its own.
 * - A body stored only as compressed RTF (old Outlook, rare). Such a mail is
 *   indexed by its headers.
 */
import { open } from "node:fs/promises";

import MsgReader from "@kenjiuno/msgreader";

import { OfficeFileRejectedError } from "./office-formats";

/**
 * Largest `.msg` we parse. The parser holds the whole file, attachments
 * included, in memory — inside the child's 384 MB heap. Mail servers cap a
 * message near 25–50 MB, so a larger file is not a mail anyone sent.
 */
export const MSG_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Body characters kept — the same bound plain-text files get (`TEXT_MAX_FILE_BYTES`). */
export const MSG_MAX_BODY_CHARS = 10 * 1024 * 1024;

/**
 * Recipients listed per header. A mail to a distribution list of 400 people
 * would otherwise fill the first chunk with addresses and push the body out
 * of it.
 */
export const MSG_MAX_RECIPIENTS = 50;

/** The Compound File signature every `.msg` starts with. */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export interface ParsedEmail {
  subject: string;
  /** "Name <address>", or whichever of the two the message carries. */
  from: string | null;
  to: string[];
  cc: string[];
  /** "YYYY-MM-DD HH:MM UTC" — delivery time, else submit time. */
  date: string | null;
  body: string;
  attachments: string[];
  bodyTruncated: boolean;
}

export interface ParseMsgOptions {
  maxBytes?: number;
  maxBodyChars?: number;
}

export async function parseMsg(path: string, opts: ParseMsgOptions = {}): Promise<ParsedEmail> {
  const maxBytes = opts.maxBytes ?? MSG_MAX_FILE_BYTES;
  const maxBodyChars = opts.maxBodyChars ?? MSG_MAX_BODY_CHARS;

  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) {
      throw new OfficeFileRejectedError(
        "too_large",
        `${path} is ${size} bytes, more than the ${maxBytes} bytes an Outlook message may have`
      );
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length < CFB_MAGIC.length || !bytes.subarray(0, CFB_MAGIC.length).equals(CFB_MAGIC)) {
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `${path} is not an Outlook message (no Compound File signature)`
    );
  }

  const data = new MsgReader(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  ).getFileData();
  if (data.error) {
    throw new OfficeFileRejectedError("unexpected_content", `${path}: ${data.error}`);
  }

  const recipients = data.recipients ?? [];
  const listOf = (type: "to" | "cc") =>
    capList(
      recipients
        .filter((r) => (r.recipType ?? "to") === type)
        .map((r) => address(r.name, r.smtpAddress ?? r.email))
        .filter((r): r is string => r !== null)
    );

  let body = (data.body ?? "").trim();
  if (!body && data.bodyHtml) body = stripHtml(data.bodyHtml);
  if (!body && data.html) body = stripHtml(new TextDecoder().decode(data.html));
  const bodyTruncated = body.length > maxBodyChars;
  if (bodyTruncated) body = body.slice(0, maxBodyChars);

  return {
    subject: (data.subject ?? "").trim(),
    from: address(data.senderName, data.senderSmtpAddress ?? data.senderEmail),
    to: listOf("to"),
    cc: listOf("cc"),
    date: formatDate(data.messageDeliveryTime ?? data.clientSubmitTime),
    body,
    attachments: (data.attachments ?? [])
      .filter((a) => !a.attachmentHidden)
      .map((a) => (a.fileName ?? a.fileNameShort ?? a.name ?? "").trim())
      .filter(Boolean),
    bodyTruncated,
  };
}

/** The text the index stores: headers a reader searches for, a blank line, the body. */
export function formatEmailText(email: ParsedEmail): string {
  const headers = [
    email.subject && `Subject: ${email.subject}`,
    email.from && `From: ${email.from}`,
    email.to.length > 0 && `To: ${email.to.join(", ")}`,
    email.cc.length > 0 && `Cc: ${email.cc.join(", ")}`,
    email.date && `Date: ${email.date}`,
    email.attachments.length > 0 && `Attachments: ${email.attachments.join(", ")}`,
  ].filter(Boolean);
  return [...headers, "", email.body].join("\n").trim();
}

/**
 * One line naming the mail, put in front of every chunk after the first: that
 * chunk has lost the header block, and a search hit in the middle of a long
 * mail should still say which mail it is.
 */
export function emailContextLine(email: ParsedEmail): string {
  const by = [email.from && `from ${email.from}`, email.date].filter(Boolean).join(", ");
  return `Email: ${email.subject || "(no subject)"}${by ? ` — ${by}` : ""}`;
}

function address(name: string | undefined, email: string | undefined): string | null {
  const n = name?.trim();
  const e = email?.trim();
  if (n && e && n !== e) return `${n} <${e}>`;
  return n || e || null;
}

function capList(items: string[]): string[] {
  if (items.length <= MSG_MAX_RECIPIENTS) return items;
  return [...items.slice(0, MSG_MAX_RECIPIENTS), `and ${items.length - MSG_MAX_RECIPIENTS} more`];
}

function formatDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const HTML_BLOCK_BOUNDARY_RE =
  /<\/?(?:p|div|br|tr|li|ul|ol|h[1-6]|table|thead|tbody|blockquote|section|article|pre|hr)\b[^>]*>/gi;

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/**
 * An HTML mail body as readable text. The same reduction `pinchy-email` applies
 * to mail it reads (`email-adapter.ts`); a copy, because a plugin and the web
 * app cannot share a module (each plugin is mounted standalone).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(HTML_BLOCK_BOUNDARY_RE, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (m, name: string) => {
      return HTML_ENTITIES[name.toLowerCase()] ?? m;
    })
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
