import { readFile } from "fs/promises";
import { join } from "path";
import type { ChatAttachment } from "openclaw-node";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { promoteStagedToAttached } from "@/lib/uploads";
import { getWorkspacePath, getOpenClawWorkspacePath } from "@/lib/workspace";

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

// ── materializeAttachments ───────────────────────────────────────────────────

export class AttachmentNotFoundError extends Error {
  constructor(public readonly ids: string[]) {
    super(`Attachment(s) not found or not accessible: ${ids.join(", ")}`);
    this.name = "AttachmentNotFoundError";
  }
}

export class AttachmentExpiredError extends Error {
  constructor(public readonly ids: string[]) {
    super(`Attachment(s) have expired: ${ids.join(", ")}`);
    this.name = "AttachmentExpiredError";
  }
}

export class AttachmentAlreadyAttachedError extends Error {
  constructor(public readonly ids: string[]) {
    super(`Attachment(s) have already been attached: ${ids.join(", ")}`);
    this.name = "AttachmentAlreadyAttachedError";
  }
}

export interface MaterializeParams {
  agentId: string;
  userId: string;
  /** Upload IDs from the WS message frame. */
  attachmentIds: string[];
  /** The WS message being sent — stored on the DB row for traceability. */
  messageId: string;
  /** Agent display name, snapshotted in audit detail. */
  agentName: string;
}

/**
 * Server-side second phase of the two-phase upload flow.
 *
 * Looks up the staged upload rows by `(id, userId, agentId, status=staged)`,
 * validates expiry + status, atomically promotes each staged file to its
 * durable `uploads/` path, flips the DB row to `attached`, emits per-file
 * `file.upload.attached` audit events, and returns the same
 * `ProcessAttachmentsResult` shape used by the WS send-path.
 *
 * Throws:
 *   `AttachmentNotFoundError`        — id missing or owned by another user/agent
 *   `AttachmentExpiredError`         — staged file has passed `expiresAt`
 *   `AttachmentAlreadyAttachedError` — row is already `attached`
 *
 * **Note on partial failure:** If `promoteStagedToAttached` or the subsequent
 * FS read throws for file N after files 0..N-1 have already been promoted,
 * earlier files are durably placed in `uploads/` and their rows are `attached`
 * in the DB. This partial state cannot be automatically rolled back (FS rename
 * and DB write are not transactional). If this function throws, callers should
 * treat the entire send as failed and inform the user to retry — any
 * partially-materialized files will remain attached to the (unsent) messageId
 * and become reachable by the agent in a future correct send.
 */
export async function materializeAttachments(
  params: MaterializeParams
): Promise<ProcessAttachmentsResult> {
  const { agentId, userId, attachmentIds, messageId, agentName } = params;

  if (attachmentIds.length === 0) {
    return { chatAttachments: [], workspaceRefs: [] };
  }

  // Step 1: fetch rows owned by (userId, agentId) with the requested IDs
  // that are still in `staged` status.
  const rows = await db
    .select()
    .from(uploadedFiles)
    .where(
      and(
        inArray(uploadedFiles.id, attachmentIds),
        eq(uploadedFiles.userId, userId),
        eq(uploadedFiles.agentId, agentId),
        eq(uploadedFiles.status, "staged")
      )
    );

  const foundIds = new Set(rows.map((r) => r.id));

  // Step 2: check for IDs not returned by the staged query — could be
  // not-found/wrong-owner, or already attached (different status).
  const unseenIds = attachmentIds.filter((id) => !foundIds.has(id));
  if (unseenIds.length > 0) {
    // Secondary lookup: check if any unseen IDs are already-attached rows
    // owned by the same (userId, agentId). If so, surface a specific error.
    const attachedRows = await db
      .select()
      .from(uploadedFiles)
      .where(
        and(
          inArray(uploadedFiles.id, unseenIds),
          eq(uploadedFiles.userId, userId),
          eq(uploadedFiles.agentId, agentId),
          eq(uploadedFiles.status, "attached")
        )
      );
    const attachedIds = new Set(attachedRows.map((r) => r.id));

    // Rows that exist as attached
    const alreadyAttachedIds = unseenIds.filter((id) => attachedIds.has(id));
    if (alreadyAttachedIds.length > 0) {
      for (const uploadId of alreadyAttachedIds) {
        await appendAuditLog({
          eventType: "file.upload.attached",
          actorType: "user",
          actorId: userId,
          outcome: "failure",
          detail: { uploadId, reason: "already_attached" },
        });
      }
      throw new AttachmentAlreadyAttachedError(alreadyAttachedIds);
    }

    // Remaining unseen IDs are genuinely missing (cross-user attack, wrong agent, etc.)
    const missingIds = unseenIds.filter((id) => !attachedIds.has(id));
    for (const uploadId of missingIds) {
      await appendAuditLog({
        eventType: "file.upload.attached",
        actorType: "user",
        actorId: userId,
        outcome: "failure",
        detail: { uploadId, reason: "not_found" },
      });
    }
    throw new AttachmentNotFoundError(missingIds);
  }

  const now = new Date();

  // Step 3: check for expired rows
  const expiredRows = rows.filter((r) => r.expiresAt !== null && r.expiresAt < now);
  if (expiredRows.length > 0) {
    for (const row of expiredRows) {
      await appendAuditLog({
        eventType: "file.upload.attached",
        actorType: "user",
        actorId: userId,
        outcome: "failure",
        detail: { uploadId: row.id, reason: "expired" },
      });
    }
    throw new AttachmentExpiredError(expiredRows.map((r) => r.id));
  }

  // Step 5: promote each staged file
  const workspaceRoot = getWorkspacePath(agentId);
  const openClawWorkspaceRoot = getOpenClawWorkspacePath(agentId);

  const chatAttachments: ChatAttachment[] = [];
  const workspaceRefs: ProcessedWorkspaceRef[] = [];

  // Process sequentially to keep audit order deterministic and avoid
  // racing two renames into the same collision-suffix slot.
  for (const row of rows) {
    if (!row.stagingPath) {
      throw new Error(
        `Uploaded file ${row.id} has status='staged' but missing stagingPath — data integrity error`
      );
    }
    const stagedRelativePath = row.stagingPath;

    // 5a: promote staged → uploads/
    const promoted = await promoteStagedToAttached({
      workspaceRoot,
      stagedRelativePath,
      filename: row.filename,
    });

    // 5b: flip DB row to attached
    await db
      .update(uploadedFiles)
      .set({
        status: "attached",
        messageId,
        attachedAt: now,
        expiresAt: null,
      })
      .where(eq(uploadedFiles.id, row.id));

    // 5c: for image MIMEs — re-read the durable file and base64-encode
    if (row.mimeType.startsWith("image/")) {
      const durablePath = join(workspaceRoot, promoted.relativePath);
      const fileBuffer = await readFile(durablePath);
      const content = fileBuffer.toString("base64");
      chatAttachments.push({ mimeType: row.mimeType, fileName: row.filename, content });
    }

    // 5d/5e: build workspace ref
    const absolutePath = join(openClawWorkspaceRoot, promoted.relativePath);
    workspaceRefs.push({
      relativePath: promoted.relativePath,
      absolutePath,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      reused: false,
    });

    // 5f: emit success audit event
    await appendAuditLog({
      eventType: "file.upload.attached",
      actorType: "user",
      actorId: userId,
      outcome: "success",
      detail: {
        uploadId: row.id,
        messageId,
        filename: row.filename,
        agent: { id: agentId, name: agentName },
      },
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
  // Text formats (CSV, Markdown, JSON, YAML, plain text) are workspace files
  // read via the pinchy_read plugin tool rather than an OpenClaw built-in.
  if (
    mimeType === "text/plain" ||
    mimeType === "text/csv" ||
    mimeType === "text/markdown" ||
    mimeType === "application/json" ||
    mimeType === "text/yaml"
  )
    return "`pinchy_read`";
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
