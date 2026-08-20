import { fileTypeFromBuffer } from "file-type";

// Covers ASCII control chars (C0 + DEL), zero-width and BiDi formatting
// characters, BiDi isolates, and the BOM. Using explicit `\u…` escapes
// instead of literal invisible characters so editors that normalise
// whitespace can never silently break this rule. Specifically:
//   \x00-\x1f         C0 control characters
//   \x7f              DEL
//   ​-‏     ZWSP, ZWNJ, ZWJ, LRM, RLM
//   ‪-‮     LRE, RLE, PDF, LRO, RLO (BiDi formatting)
//   ⁦-⁩     LRI, RLI, FSI, PDI (BiDi isolates)
//   ﻿            BOM / ZWNBSP
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const MAX_FILENAME_LEN = 255;

// Reject characters that break downstream string contexts:
//
//   `   \u2014 would close the markdown code span the agent reads in the
//         attachment block, opening a prompt-injection trick path.
//   "   \u2014 would terminate the quoted form of Content-Disposition
//         emitted by the uploads route (RFC 6266).
//
// Both are vanishingly rare in real filenames. Rejecting them at the trust
// boundary eliminates two whole classes of downstream escaping bugs and lets
// us drop the per-context escape helpers that previously papered over the
// problem (e.g. `escapeForMarkdownCodeSpan` in attachment-pipeline.ts).
const FORBIDDEN_CHAR_RE = /["`]/;

export function sanitizeFilename(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("Invalid filename: not a string");
  }

  // Canonicalize to NFC before anything else. macOS uploads a filename in NFD
  // (decomposed) form — "ä" arrives as "a" + U+0308 combining diaeresis. Stored
  // verbatim on the Linux workspace volume (which does no Unicode folding), the
  // file then can't be read back: the attachment path round-trips through JSON
  // and the agent's own model, both of which emit NFC, so `pinchy_read` is handed
  // the composed form and readFile ENOENTs with "no such file or directory".
  // Normalizing here makes the stored name, the DB row, and the path the agent
  // sees all identical bytes. (prod incident 2026-07-14)
  raw = raw.normalize("NFC");

  if (CONTROL_CHAR_RE.test(raw)) {
    throw new Error("Invalid filename: contains control characters");
  }
  if (FORBIDDEN_CHAR_RE.test(raw)) {
    throw new Error("Invalid filename: contains forbidden characters");
  }
  if (raw.startsWith("./") || raw.startsWith(".\\")) {
    throw new Error("Invalid filename: absolute or relative path");
  }

  // Strip directory components, keep last segment.
  const parts = raw.replace(/\\/g, "/").split("/");

  // Reject any component that is exactly ".." (path traversal).
  for (const part of parts.slice(0, -1)) {
    if (part === "..") {
      throw new Error("Invalid filename: contains parent-directory reference");
    }
  }

  const last = parts[parts.length - 1];
  const trimmed = last.trim();

  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("Invalid filename: empty or reserved");
  }

  if (trimmed.length > MAX_FILENAME_LEN) {
    throw new Error("Invalid filename: too long");
  }

  return trimmed;
}

// Audio is intentionally absent — see #321. Adding audio MIMEs here without
// also wiring transcription means the agent receives a file it cannot read.
//
// text/vcard is ALSO listed in ALLOWED_TEXT_MIMES below; see isKnownMimeAlias
// for why vCard lives in both allowlists.
/**
 * Extension for each MIME the upload path accepts. Only used to NAME a file
 * that arrived without a usable name — never to re-type one that has an
 * extension already.
 */
const EXT_BY_MIME = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["text/vcard", "vcf"],
  ["text/x-vcard", "vcf"],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
  ["text/markdown", "md"],
  ["application/json", "json"],
  ["text/yaml", "yaml"],
]);

/**
 * Stems that carry no information about the file. Browsers produce these for
 * anything pasted from the clipboard or dragged out of a viewer.
 */
const GENERIC_STEMS = new Set(["blob", "upload", "image", "download", "file", "untitled"]);

/** Strip a trailing " (n)" collision suffix: "blob (17)" -> "blob". */
function stripCollisionSuffix(stem: string): string {
  return stem.replace(/ \(\d+\)$/, "");
}

/**
 * Give an upload a name worth having (heypinchy/pinchy#1199).
 *
 * A browser hands us `blob` for a pasted or dragged file — no extension, no
 * hint of content. On one production agent's workspace that was 68 of 253
 * files, and identifying each one costs a `pinchy_read` against a vision model
 * on a context that is already under pressure. `pinchy_ls` is close to useless
 * on such a listing, and so is asking the user "did you send me that receipt".
 *
 * Two narrow rules, both driven by the VALIDATED mime (the truth about the
 * bytes, known by the time this runs):
 *
 *  - a generic stem is replaced with a dated one, so a listing sorts and reads
 *    meaningfully;
 *  - a missing extension is filled in, so the file opens.
 *
 * A stem the user chose is information and is kept. A present-but-wrong
 * extension is left alone: renaming a user-named file on a MIME mismatch is a
 * different (and lossy) decision from naming a file that has no name at all.
 *
 * `now` is a parameter rather than read here so the behaviour is testable
 * without freezing the clock.
 */
export function meaningfulUploadName(safeName: string, validatedMime: string, now: Date): string {
  const dot = safeName.lastIndexOf(".");
  const hasExtension = dot > 0;
  const rawStem = hasExtension ? safeName.slice(0, dot) : safeName;
  const extension = hasExtension ? safeName.slice(dot + 1) : "";

  const isGeneric = GENERIC_STEMS.has(stripCollisionSuffix(rawStem).toLowerCase());
  if (!isGeneric && hasExtension) return safeName;

  const mimeExtension = EXT_BY_MIME.get(validatedMime) ?? "bin";
  if (!isGeneric) return `${rawStem}.${mimeExtension}`;

  const day = now.toISOString().slice(0, 10);
  return `upload-${day}.${hasExtension ? extension : mimeExtension}`;
}

export const ALLOWED_ATTACHMENT_MIMES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "text/vcard",
]);

// xlsx is deliberately NOT in ALLOWED_ATTACHMENT_MIMES above, even though
// agent-generated xlsx files are servable for download (#788) — see
// serve-workspace-file.ts's DELIVERY_ONLY_BINARY_MIMES. ALLOWED_ATTACHMENT_MIMES
// also gates *uploads* (validateUploadBuffer, below), and pinchy_read has no
// xlsx extractor: an uploaded xlsx would fall through to
// `buffer.toString("utf-8")` and hand the model unreadable binary garbage —
// the same failure mode #321 documents for audio. Widening this shared set
// would silently accept uploads the agent cannot read. If a future task wires
// an xlsx reader (mirroring docx-extract.ts), add the MIME here too and it
// will automatically also become servable via SERVABLE_DELIVERED_MIMES.

// Text formats have no magic bytes, so fileTypeFromBuffer returns undefined.
// These are validated by UTF-8 null-byte guard instead.
//
// text/vcard and text/x-vcard are also listed here (vCard is normally sniffed
// by content — see ALLOWED_ATTACHMENT_MIMES above); see isKnownMimeAlias for
// why vCard lives in both allowlists.
export const ALLOWED_TEXT_MIMES = new Set<string>([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "text/yaml",
  "text/vcard",
  "text/x-vcard",
]);

// Authoritative note on why vCard is handled specially and lives in BOTH
// allowlists above (the ALLOWED_ATTACHMENT_MIMES / ALLOWED_TEXT_MIMES comments
// point here):
//
//   - file-type content-sniffs a properly-formatted `BEGIN:VCARD…END:VCARD`
//     payload and always returns the single canonical `{ mime: "text/vcard" }`
//     — regardless of vCard VERSION or what the client claimed. So a normal
//     vCard is verified through the detected-mime path (ALLOWED_ATTACHMENT_MIMES).
//   - Some real-world exports the sniffer misses (lowercase `begin:vcard` from
//     older 2.1 tools, or a leading blank line/CRLF) fall through to the
//     no-magic-bytes branch, so vCard is also in ALLOWED_TEXT_MIMES.
//   - RFC 6350 registered `text/vcard`, obsoleting the pre-standard `x-token`
//     `text/x-vcard` — but real-world clients (older macOS/Outlook export
//     flows) still commonly claim the legacy spelling for identical content.
//     Since the sniffer normalizes to `text/vcard`, the exact-match mismatch
//     check below would otherwise reject every legacy-labelled vCard as
//     spoofed content even though it's genuine.
//
// This is the only MIME alias in this module — deliberately, so a future
// addition needs the same justification (a registered synonym for the exact
// same wire format, not merely "close enough").
function isKnownMimeAlias(detectedMime: string, claimedMime: string): boolean {
  return detectedMime === "text/vcard" && claimedMime === "text/x-vcard";
}

export async function validateUploadBuffer(buffer: Buffer, claimedMime: string): Promise<string> {
  const detected = await fileTypeFromBuffer(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );

  if (!detected) {
    // Text files have no magic bytes. Accept if claimed MIME is in text allowlist
    // and content contains no null bytes (binary content guard).
    if (ALLOWED_TEXT_MIMES.has(claimedMime)) {
      if (buffer.includes(0x00)) {
        throw new Error("Binary content detected in claimed text file");
      }
      return claimedMime;
    }
    throw new Error("Unable to detect file type");
  }

  if (!ALLOWED_ATTACHMENT_MIMES.has(detected.mime)) {
    throw new Error(`File type ${detected.mime} not supported`);
  }
  if (detected.mime !== claimedMime) {
    if (!isKnownMimeAlias(detected.mime, claimedMime)) {
      throw new Error(`File type mismatch: claimed ${claimedMime}, content is ${detected.mime}`);
    }
    return claimedMime; // preserve legacy spelling only for the alias case
  }
  return detected.mime;
}
