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

/**
 * Longest context line. It is repeated in front of every chunk after the
 * first, in the indexer's own process, so its length multiplies with the
 * mail's: a crafted subject the size of the body would otherwise cost
 * gigabytes there. Real subjects and senders fit with room to spare.
 */
export const EMAIL_CONTEXT_LINE_MAX_CHARS = 300;

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

  // A file that carries the signature but is cut short (an interrupted copy, a
  // half-synced share) or damaged makes the parser throw RangeError or
  // TypeError from deep inside the Compound File walk, and a binary-typed
  // property makes the field mapping below throw. Both are facts about the
  // file, not about the machine: refused, so the file lands in the
  // unsearchable list instead of failing again on every run.
  try {
    return toParsedEmail(bytes, maxBodyChars);
  } catch (err) {
    if (err instanceof OfficeFileRejectedError) throw err;
    throw new OfficeFileRejectedError(
      "unexpected_content",
      `the file is not a readable Outlook message: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function toParsedEmail(bytes: Buffer, maxBodyChars: number): ParsedEmail {
  const data = new MsgReader(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  ).getFileData();
  if (data.error) {
    throw new OfficeFileRejectedError("unexpected_content", `the file: ${data.error}`);
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
  const line = `Email: ${email.subject || "(no subject)"}${by ? ` — ${by}` : ""}`;
  return line.length <= EMAIL_CONTEXT_LINE_MAX_CHARS
    ? line
    : `${line.slice(0, EMAIL_CONTEXT_LINE_MAX_CHARS - 1)}…`;
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

// Tested against one whole tag at a time (see `removeTags`), so it is anchored
// at both ends and cannot scan beyond the tag.
const HTML_BLOCK_TAG_RE =
  /^<\/?(?:p|div|br|tr|li|ul|ol|h[1-6]|table|thead|tbody|blockquote|section|article|pre|hr)\b[^>]*>$/i;

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
 * Drops script/style elements, comments and tags in ONE linear pass: a block
 * tag becomes a newline, anything else a space. A mail body is untrusted, and
 * the lazy-regex form of this (`<(script)[^>]*>[\s\S]*?<\/\1>`, `<!--[\s\S]*?-->`,
 * `<[^>]+>`) rescans the rest of the input from every unclosed opener, so
 * N openers cost N^2. Here a search that finds nothing is remembered (nothing
 * later can find it either), and one that finds something moves past it, so
 * every character is scanned a bounded number of times.
 *
 * A `<` that cannot start a tag (not followed by a letter, `/`, `!` or `?`,
 * as in the HTML tokenizer) is text. This function is duplicated in
 * `packages/plugins/pinchy-email/email-adapter.ts` (bundle isolation);
 * `remove-tags-drift.test.ts` pins the two bodies together.
 */
function removeTags(html: string): string {
  // ASCII-only lowering keeps indices aligned with `html`: `toLowerCase()`
  // turns U+0130 into two code units, which would shift every later index.
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const out: string[] = [];
  let i = 0;
  let noMoreGt = false;
  const noCloser = new Set<string>();
  let noCommentEnd = false;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    i = lt;

    if (!/[A-Za-z/!?]/.test(html[lt + 1] ?? "")) {
      out.push("<");
      i = lt + 1;
      continue;
    }

    if (!noCommentEnd && html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end !== -1) {
        out.push(" ");
        i = end + 3;
        continue;
      }
      noCommentEnd = true;
    }

    const gt = noMoreGt ? -1 : html.indexOf(">", lt + 1);
    if (gt === -1) {
      noMoreGt = true;
      out.push("<");
      i = lt + 1;
      continue;
    }

    const element = /^<(script|style)/.exec(lower.slice(lt, lt + 7))?.[1];
    if (element && !noCloser.has(element)) {
      const closer = `</${element}>`;
      const close = lower.indexOf(closer, gt + 1);
      if (close !== -1) {
        out.push(" ");
        i = close + closer.length;
        continue;
      }
      noCloser.add(element);
    }

    out.push(HTML_BLOCK_TAG_RE.test(html.slice(lt, gt + 1)) ? "\n" : " ");
    i = gt + 1;
  }
  return out.join("");
}

/**
 * An HTML mail body as readable text. The same reduction `pinchy-email` applies
 * to mail it reads (`email-adapter.ts`); a copy, because a plugin and the web
 * app cannot share a module (each plugin is mounted standalone).
 */
export function stripHtml(html: string): string {
  return removeTags(html)
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (m, name: string) => {
      return HTML_ENTITIES[name.toLowerCase()] ?? m;
    })
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
