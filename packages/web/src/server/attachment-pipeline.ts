import type { ChatAttachment } from "openclaw-node";
import { sanitizeFilename, validateUploadBuffer } from "@/lib/upload-validation";
import { persistAttachment, UploadSlotExhaustedError } from "@/lib/uploads";
import { getOpenClawWorkspacePath } from "@/lib/workspace";

export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface ProcessedWorkspaceRef {
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  reused: boolean;
}

export interface ProcessAttachmentsResult {
  chatAttachments: ChatAttachment[];
  workspaceRefs: ProcessedWorkspaceRef[];
}

export interface ProcessAttachmentsParams {
  agentId: string;
  contentParts: ContentPart[];
  claimedFilenames?: string[];
  /**
   * Test-only override forwarded to `persistAttachment.maxCollisions`.
   * Production callers MUST NOT set this — it exists so the slot-exhaustion
   * branch can be exercised without writing the full 1000 collision files.
   */
  maxCollisionsForTesting?: number;
}

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

/**
 * Error class for attachment problems caused by client input we should report
 * back verbatim (MIME mismatch, unsupported type, bad filename). Anything
 * thrown that is NOT a `UploadValidationError` is treated as an internal
 * server error and replaced with a generic message at the trust boundary —
 * never leaks `EACCES`/`ENOSPC`/etc to the client.
 */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

/**
 * Validates, persists, and dedups every attachment in a chat message.
 *
 * - Decodes each `image_url` content part with a `data:<mime>;base64,…` URL.
 * - Validates the buffer against the claimed MIME via `file-type` magic bytes.
 * - Sanitises the filename (or falls back to "upload").
 * - Writes the buffer to the agent's workspace via `persistAttachment`
 *   (atomic, dedup-on-content-hash, collision-suffix on different content).
 *
 * All persistence runs in parallel — N attachments × up to 15 MB each would
 * otherwise serialise the WS request path. The `for` loop below pre-computes
 * filenames in send-order to keep `claimedFilenames[i]` aligned with each
 * attachment's position in the source array, regardless of how the parallel
 * promises settle.
 *
 * Returns `chatAttachments` for inline image dispatch and `workspaceRefs`
 * for the upload hint that points the agent at the right built-in tool.
 *
 * Throws `UploadValidationError` for input the client should see; any other
 * thrown error is internal and the caller should map it to a generic message.
 */
export async function processIncomingAttachments(
  params: ProcessAttachmentsParams
): Promise<ProcessAttachmentsResult> {
  const { agentId, contentParts } = params;
  // Defensive: strip non-array values at the trust boundary so a malformed
  // payload can never reach the per-index lookup below.
  const claimedFilenames = Array.isArray(params.claimedFilenames)
    ? params.claimedFilenames
    : undefined;
  const workspaceRoot = getOpenClawWorkspacePath(agentId);

  // First pass — collect everything we need to persist, in order. This pass
  // is sync (sanitiseFilename) and quick CPU work (base64 decode), so we do
  // it serially. The expensive validation + I/O is parallelised below.
  interface PreparedAttachment {
    safeName: string;
    base64: string;
    buffer: Buffer;
    claimedMime: string;
  }
  const prepared: PreparedAttachment[] = [];
  let attachmentIdx = 0;
  for (const part of contentParts) {
    // Non-attachment parts (notably the leading `text` part — see
    // `buildWsContent` in use-ws-runtime.ts) are ignored entirely; they
    // have no slot in `claimedFilenames` so they don't advance the index.
    if (part.type !== "image_url") continue;

    // Every `image_url` part MUST carry a base64 `data:` URL. Anything
    // else (missing url, https/file URL, plain text without `;base64,`)
    // is a client-payload bug. Failing closed here keeps the
    // `image_url[i]` ↔ `claimedFilenames[i]` alignment invariant intact —
    // silently skipping a malformed slot would shift every subsequent
    // filename onto the WRONG attachment.
    if (!part.image_url?.url) {
      throw new UploadValidationError(
        `Invalid attachment payload at index ${attachmentIdx}: image_url part is missing url.`
      );
    }
    const match = part.image_url.url.match(DATA_URL_RE);
    if (!match) {
      throw new UploadValidationError(
        `Invalid attachment payload at index ${attachmentIdx}: ` +
          `image_url must be a base64 data: URL.`
      );
    }

    const claimedMime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, "base64");

    // The client sends `""` for image slots in mixed image+binary messages
    // (images don't carry a meaningful filename). Treat empty/whitespace
    // strings as nullish here — `??` alone misses the empty-string case.
    const rawName = claimedFilenames?.[attachmentIdx];
    const claimedName = typeof rawName === "string" && rawName.trim() ? rawName : "upload";
    let safeName: string;
    try {
      safeName = sanitizeFilename(claimedName);
    } catch (err) {
      throw new UploadValidationError(err instanceof Error ? err.message : String(err));
    }

    prepared.push({ safeName, base64, buffer, claimedMime });
    attachmentIdx++;
  }

  // Validate + persist in parallel — order is preserved by Promise.all.
  const persisted = await Promise.all(
    prepared.map(async ({ safeName, buffer, claimedMime }) => {
      let detectedMime: string;
      try {
        detectedMime = await validateUploadBuffer(buffer, claimedMime);
      } catch (err) {
        throw new UploadValidationError(err instanceof Error ? err.message : String(err));
      }
      let ref;
      try {
        ref = await persistAttachment({
          agentId,
          filename: safeName,
          buffer,
          // `maxCollisionsForTesting` is undefined in production → falls back
          // to the persistAttachment default (1000). Tests pass a small value
          // to exercise the slot-exhaustion branch without writing 1000 files.
          ...(params.maxCollisionsForTesting !== undefined
            ? { maxCollisions: params.maxCollisionsForTesting }
            : {}),
        });
      } catch (err) {
        // Slot exhaustion is caused by client input (uploading thousands of
        // distinct files under one name) and is recoverable by renaming.
        // Surface it verbatim — see UploadValidationError jsdoc above.
        if (err instanceof UploadSlotExhaustedError) {
          throw new UploadValidationError(err.message);
        }
        throw err;
      }
      return { detectedMime, ref };
    })
  );

  const chatAttachments: ChatAttachment[] = [];
  const workspaceRefs: ProcessedWorkspaceRef[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const { safeName, base64, buffer } = prepared[i];
    const { detectedMime, ref } = persisted[i];

    // Only images can be sent inline to the LLM (vision models accept them).
    // PDFs and other binary files go workspace-only — the agent reads them
    // via the built-in `pdf` / `image` tools using the workspace path from
    // the upload hint. OpenClaw's `agent` entrypoint rejects non-image
    // inline attachments anyway (`acceptNonImage: false`).
    if (detectedMime.startsWith("image/")) {
      chatAttachments.push({ mimeType: detectedMime, fileName: safeName, content: base64 });
    }
    workspaceRefs.push({
      relativePath: ref.relativePath,
      absolutePath: `${workspaceRoot}/${ref.relativePath}`,
      mimeType: detectedMime,
      sizeBytes: buffer.length,
      contentHash: ref.contentHash,
      reused: ref.reused,
    });
  }

  return { chatAttachments, workspaceRefs };
}

/**
 * Resolve the built-in OpenClaw tool name for a given attachment MIME type.
 *
 * Throws if a MIME type slips through that's outside the documented set —
 * the upload hint must be specific (which built-in tool to call), and a
 * silent fallback ("the appropriate built-in tool") would leave the agent
 * guessing. If a new attachment type is whitelisted, this function must be
 * updated in the same change.
 */
function toolNameForMime(mimeType: string): string {
  if (mimeType === "application/pdf") return "`pdf`";
  if (mimeType.startsWith("image/")) return "`image`";
  throw new Error(
    `attachment-pipeline: no built-in tool registered for MIME ${mimeType}. ` +
      `Update toolNameForMime() when adding a new attachment type.`
  );
}

// ── Attachment-block format — single source of truth ────────────────────
//
// The in-message attachment block has two consumers that MUST stay in sync:
//
//   buildAttachmentBlock()  — writes the block into the user message text
//                             before forwarding to OpenClaw.
//   parseAttachmentBlock()  — strips the block on history-reload and lifts
//                             the metadata into the wire-level `files` field.
//
// Drift between them silently breaks the chip-on-reload UX. To prevent that,
// both share the constants and helpers below. Update them together, and add
// a round-trip test in `attachment-pipeline.test.ts` for any format change.
//
// The block tag is deliberately custom (namespaced under `pinchy:`) so the
// strip step cannot collide with anything the user might legitimately type.
const ATTACHMENT_BLOCK_OPEN = "<pinchy:attachments>";
const ATTACHMENT_BLOCK_CLOSE = "</pinchy:attachments>";

// One line per attachment, format:
//   - `<absolute-path>` (<mime>, <size>) — analyze with `<tool>`
//
// `<absolute-path>` cannot contain a backtick (sanitizeFilename rejects them,
// buildAttachmentBlock asserts it), so the simple `[^`]+` capture is sound.
const LINE_PREFIX = "- ";
const ATTACHMENT_LINE_RE = /^- `([^`]+)` \(([^,]+),/;

function formatAttachmentLine(
  absolutePath: string,
  mimeType: string,
  sizeBytes: number,
  toolName: string
): string {
  return `${LINE_PREFIX}\`${absolutePath}\` (${mimeType}, ${formatBytes(sizeBytes)}) — analyze with ${toolName}`;
}

/**
 * Build the per-message attachment metadata block that gets *appended* to the
 * user's chat message text before the message is forwarded to OpenClaw.
 *
 * Why per-message (not in `extraSystemPrompt`)?
 *
 * OpenClaw persists the user message text into its session JSONL but does NOT
 * persist the system prompt — that gets rebuilt on every turn from the agent
 * config. If we put the upload paths into the system prompt, then on Turn 2
 * the agent's *own history view* of Turn 1 contains "Was steht in dieser
 * Datei?" with no record of which file. The model's attention then drifts to
 * whichever upload was discussed at length in the recent assistant response,
 * even when the user's new turn carries a brand-new file.
 *
 * Embedding the path-list in the user message text fixes this: the file ↔ turn
 * mapping is now part of the immutable message record. As a bonus, on history
 * reload we can parse the same block back out and render the file chip without
 * any separate persistence layer.
 *
 * The block is wrapped in a `<pinchy:attachments>` tag (not a markdown heading
 * or code fence) so the strip/parse step on the display side has an
 * unambiguous boundary that user-typed text cannot accidentally produce.
 */
export function buildAttachmentBlock(refs: ProcessedWorkspaceRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((r) => {
    // Defense in depth: sanitizeFilename rejects backticks at the upload trust
    // boundary, so the path emitted by `persistAttachment` cannot contain one
    // under normal operation. If a hand-built ref ever does, fail loud — a
    // silent substitution would corrupt the on-disk path the agent must call
    // its built-in tool with, and the agent would see "file not found".
    if (r.absolutePath.includes("`")) {
      throw new Error(
        `buildAttachmentBlock: absolutePath contains a backtick which would break the markdown code span: ${r.absolutePath}`
      );
    }
    const tool = toolNameForMime(r.mimeType);
    return formatAttachmentLine(r.absolutePath, r.mimeType, r.sizeBytes, tool);
  });
  return [
    ATTACHMENT_BLOCK_OPEN,
    "The user attached these files (already saved into your workspace). Read each file with the listed built-in tool, using the exact absolute path:",
    ...lines,
    "",
    "If you delegate this task to a sub-agent or another tool, pass these exact paths verbatim — do not retype from memory.",
    ATTACHMENT_BLOCK_CLOSE,
  ].join("\n");
}

export interface ParsedAttachment {
  /** Absolute workspace path. */
  path: string;
  /** Display filename (last path segment). */
  filename: string;
  /** MIME type as recorded at upload time. */
  mimeType: string;
}

export interface ParseAttachmentBlockResult {
  cleanText: string;
  attachments: ParsedAttachment[];
}

/**
 * Inverse of `buildAttachmentBlock`: pulls the trailing block (and the blank
 * line that separates it from the user text) out of a message, returning the
 * clean user-visible text plus the parsed attachment list.
 *
 * Refuses to strip if the block is malformed (e.g. opening tag without a
 * closing tag) — better to show the raw markup once than to silently eat half
 * the user's message after a future format change.
 */
export function parseAttachmentBlock(text: string): ParseAttachmentBlockResult {
  const openIdx = text.indexOf(ATTACHMENT_BLOCK_OPEN);
  if (openIdx === -1) return { cleanText: text, attachments: [] };
  const closeIdx = text.indexOf(ATTACHMENT_BLOCK_CLOSE, openIdx);
  if (closeIdx === -1) return { cleanText: text, attachments: [] };

  const blockBody = text.slice(openIdx + ATTACHMENT_BLOCK_OPEN.length, closeIdx);
  const attachments: ParsedAttachment[] = [];
  for (const line of blockBody.split("\n")) {
    const m = line.match(ATTACHMENT_LINE_RE);
    if (!m) continue;
    const path = m[1];
    const mimeType = m[2];
    const filename = path.slice(path.lastIndexOf("/") + 1);
    attachments.push({ path, filename, mimeType });
  }

  // Strip the block AND the blank-line separator that `buildAttachmentBlock`
  // is designed to follow (we always emit `<text>\n\n<block>`). Trim trailing
  // whitespace so a message that was *only* a block doesn't leave a dangling
  // newline.
  const before = text.slice(0, openIdx).replace(/\n*$/, "");
  const after = text.slice(closeIdx + ATTACHMENT_BLOCK_CLOSE.length);
  const cleanText = (before + after).replace(/\s+$/, "");
  return { cleanText, attachments };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
