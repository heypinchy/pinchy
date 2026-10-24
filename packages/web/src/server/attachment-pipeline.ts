import { readFile, open } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { join } from "path";
import type { ChatAttachment } from "openclaw-node";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { promoteStagedToAttached, attachedRelativePath } from "@/lib/uploads";
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

/**
 * A retry named an upload whose row says `attached` but whose bytes are no
 * longer in `uploads/`.
 *
 * Its own class rather than a bare `Error` for the same reason the three above
 * have one: `client-router` maps each to a specific error code, and anything
 * unrecognised falls into the generic "Could not process attachment. Please
 * try again." — advice that can only ever fail again, because nothing about
 * the missing file changes between attempts.
 */
export class AttachmentFileMissingError extends Error {
  constructor(
    public readonly ids: string[],
    public readonly relativePaths: string[]
  ) {
    super(
      `Attachment file(s) missing from the agent workspace: ${relativePaths.join(", ")}. ` +
        `The upload record still exists but the file does not — it cannot be re-sent.`
    );
    this.name = "AttachmentFileMissingError";
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
  /**
   * True when this frame is a retry of a message the user already sent (#1195).
   * Retries carry the original attachment ids, so rows that the first attempt
   * already promoted are re-referenced rather than refused — see the
   * already-attached branch for why this is gated instead of allowed generally.
   */
  isRetry?: boolean;
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
 * The returned `workspaceRefs` and `chatAttachments` follow the caller's own
 * `attachmentIds` order, with repeats collapsed — so the manifest the agent
 * reads lists the files in the order the user attached them, whether each one
 * was promoted this turn or re-referenced from an earlier attempt.
 *
 * Throws:
 *   `AttachmentNotFoundError`        — id missing or owned by another user/agent
 *   `AttachmentExpiredError`         — staged file has passed `expiresAt`
 *   `AttachmentAlreadyAttachedError` — row is already `attached`, and this is
 *                                      not a retry (see `isRetry`)
 *   `AttachmentFileMissingError`     — a retry named an `attached` row whose
 *                                      file is gone from `uploads/`
 *
 * **Note on partial failure:** If `promoteStagedToAttached` or the subsequent
 * FS read throws for file N after files 0..N-1 have already been promoted,
 * earlier files are durably placed in `uploads/` and their rows are `attached`
 * in the DB. This partial state cannot be automatically rolled back (FS rename
 * and DB write are not transactional). If this function throws, callers should
 * treat the entire send as failed and inform the user to retry.
 *
 * Before #1195 the already-promoted rows were then unreachable: retries carried
 * no attachment ids, so nothing ever named them again and they sat in
 * `uploads/` as durable orphans. A retry now re-sends the ids and step 6
 * re-references those rows instead of orphaning them — but only for as long as
 * something still knows the ids. They live in the client's message state and in
 * the `files` metadata the history frame carries (`history-upload-ids.ts`), so
 * a user who instead clears the composer and rewrites the message leaves the
 * same durable orphan behind as before. That residue is
 * bounded and rare (it needs an FS or DB error mid-loop) and is reclaimed by an
 * operator or a future workspace-GC pass, not automatically. What is never
 * recovered is a row whose file is not on disk at all: step 6 refuses to emit a
 * ref for it rather than pointing the agent at nothing.
 */
export async function materializeAttachments(
  params: MaterializeParams
): Promise<ProcessAttachmentsResult> {
  const { agentId, userId, attachmentIds, messageId, agentName, isRetry = false } = params;

  // Deduplicate up front. `attachmentIdsSchema` bounds the frame to 10 UUIDs
  // but does not require them to be distinct, and every list below is derived
  // from this one — so a repeated id would otherwise reach step 6 as a
  // repeated ref AND, for an image, as a second base64 copy of the same bytes
  // in the model request. The staged path never had this shape because its
  // `inArray` query collapses repeats on its own.
  const requestedIds = [...new Set(attachmentIds)];

  if (requestedIds.length === 0) {
    return { chatAttachments: [], workspaceRefs: [] };
  }

  // Position of each id in the caller's list — the order the user attached the
  // files, and therefore the order the manifest must list them in.
  const requestedOrder = new Map(requestedIds.map((id, i) => [id, i]));
  const byRequestedOrder = (a: { id: string }, b: { id: string }) =>
    requestedOrder.get(a.id)! - requestedOrder.get(b.id)!;

  // Step 1: fetch rows owned by (userId, agentId) with the requested IDs
  // that are still in `staged` status.
  const rows = await db
    .select()
    .from(uploadedFiles)
    .where(
      and(
        inArray(uploadedFiles.id, requestedIds),
        eq(uploadedFiles.userId, userId),
        eq(uploadedFiles.agentId, agentId),
        eq(uploadedFiles.status, "staged")
      )
    );

  const foundIds = new Set(rows.map((r) => r.id));

  // Rows a retry re-references rather than attaches (#1195). Filled in step 2,
  // consumed in step 6; declared here so it survives the block scope.
  let retriedRows: (typeof uploadedFiles.$inferSelect)[] = [];

  // Step 2: check for IDs not returned by the staged query — could be
  // not-found/wrong-owner, or already attached (different status).
  const unseenIds = requestedIds.filter((id) => !foundIds.has(id));
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

    // A RETRY re-sends the message it is retrying, attachment ids and all
    // (heypinchy/pinchy#1195). If the first attempt got far enough to
    // materialize them, those rows are now `attached` — and refusing the frame
    // over that would reject the whole retry, which is worse than the bug it
    // replaced. On a retry they are re-referenced instead: the bytes are
    // already in `uploads/`, so the manifest can be rebuilt without attaching
    // anything a second time.
    //
    // Gated on `isRetry` rather than allowed generally, because the error still
    // has a job on an ordinary send: an upload belongs to the message it was
    // composed with. The rows are already scoped to (userId, agentId), so the
    // widest this reaches is a user re-referencing their own file in their own
    // agent's workspace — which that agent can `pinchy_ls` regardless.
    retriedRows = isRetry ? attachedRows : [];

    // Rows that exist as attached, on a send that is not a retry. On a retry
    // every one of them is in `retriedRows` above, so this is empty by
    // construction — spelled as the flag rather than as a set difference,
    // which only restates it.
    const alreadyAttachedIds = isRetry ? [] : unseenIds.filter((id) => attachedIds.has(id));
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
    // Guard the throw: on a retry every id can be accounted for by retriedRows,
    // and an unguarded throw here would reject that frame with an empty id list.
    if (missingIds.length > 0) {
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

  // Step 4: promote each staged file
  const workspaceRoot = getWorkspacePath(agentId);
  const openClawWorkspaceRoot = getOpenClawWorkspacePath(agentId);

  // Keyed by upload id, assembled into the caller's order at the end. Both
  // loops below emit their audit rows in that same order, so "file-0's audit
  // precedes file-1's" is a statement about the user's own selection rather
  // than about whatever order Postgres happened to return.
  const refById = new Map<string, ProcessedWorkspaceRef>();
  const chatAttachmentById = new Map<string, ChatAttachment>();

  // Process sequentially. Filename collisions are already resolved at stage
  // time (`persistStagedUpload` reserves `uploads/<filename>` via
  // O_CREAT|O_EXCL with a numeric suffix), so the historical reason — racing
  // two renames into the same suffix slot — no longer applies. We keep the
  // sequential loop for two narrower reasons: per-message audit ordering
  // stays deterministic (file-0 audit precedes file-1 audit), and the
  // partial-failure surface is easier to reason about (Promise.all would
  // leave in-flight renames running after the first rejection, broadening
  // the orphan set documented in the jsdoc above).
  for (const row of [...rows].sort(byRequestedOrder)) {
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
      chatAttachmentById.set(row.id, {
        mimeType: row.mimeType,
        fileName: row.filename,
        content,
      });
    }

    // 5d/5e: build workspace ref
    const absolutePath = join(openClawWorkspaceRoot, promoted.relativePath);
    refById.set(row.id, {
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

  // Step 6: rebuild refs for rows an earlier attempt at this message already
  // attached — a retry.
  //
  // Nothing here promotes or writes: the bytes have been sitting in `uploads/`
  // since that attempt, and the DB row is already `attached`. All that is
  // missing is the ref the caller needs in order to rebuild the attachment
  // manifest, so the agent is handed the same paths it was handed before.
  //
  // The row is stamped with the FIRST attempt's `messageId`, not this frame's —
  // client-router mints a fresh UUID per frame, which is exactly why the gate
  // is `isRetry` and not message-id equality. Nothing here re-stamps it: the
  // column is a write-only traceability record of when the bytes were promoted,
  // and rewriting it would erase that.
  for (const row of [...retriedRows].sort(byRequestedOrder)) {
    const relativePath = attachedRelativePath(row.filename);
    const durablePath = join(workspaceRoot, relativePath);

    // The path is derived, not stored, so prove it before handing it over. A
    // ref that resolves to nothing would send the agent to read a file that is
    // not there and have it report the attachment as unreadable — a silent
    // wrong answer in place of a loud failure.
    //
    // Proved by OPENING it, not by stat-ing it and reading later: a separate
    // check and use is a TOCTOU window (CodeQL js/file-system-race), and the
    // read below would then be operating on a path whose state was established
    // by an earlier, unrelated syscall. One handle answers both questions.
    let handle: FileHandle;
    try {
      handle = await open(durablePath, "r");
    } catch {
      // Audited like every other refusal in this function: without a row, a
      // user retrying into a permanently-failing send leaves no trace on the
      // Pinchy side at all.
      await appendAuditLog({
        eventType: "file.upload.attached",
        actorType: "user",
        actorId: userId,
        outcome: "failure",
        detail: { uploadId: row.id, messageId, filename: row.filename, reason: "file_missing" },
      });
      throw new AttachmentFileMissingError([row.id], [relativePath]);
    }

    try {
      if (row.mimeType.startsWith("image/")) {
        const fileBuffer = await handle.readFile();
        chatAttachmentById.set(row.id, {
          mimeType: row.mimeType,
          fileName: row.filename,
          content: fileBuffer.toString("base64"),
        });
      }
    } finally {
      await handle.close();
    }

    refById.set(row.id, {
      relativePath,
      absolutePath: join(openClawWorkspaceRoot, relativePath),
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      reused: true,
    });

    // A re-reference is still a delivery of this file to the agent on this
    // turn, so it belongs in the trail — `chat.retry_triggered` names the agent
    // and the reason but no filenames, and without a row here the question
    // "which files did this turn hand over?" has no answer. `reason` marks it
    // so a query counting real attaches can exclude it; a separate event type
    // would have been the cleaner spelling but is not worth widening the
    // catalogue for a variant of the same fact.
    await appendAuditLog({
      eventType: "file.upload.attached",
      actorType: "user",
      actorId: userId,
      outcome: "success",
      detail: {
        uploadId: row.id,
        messageId,
        filename: row.filename,
        reason: "retry_reference",
        agent: { id: agentId, name: agentName },
      },
    });
  }

  const workspaceRefs = requestedIds
    .map((id) => refById.get(id))
    .filter((ref): ref is ProcessedWorkspaceRef => ref !== undefined);
  const chatAttachments = requestedIds
    .map((id) => chatAttachmentById.get(id))
    .filter((att): att is ChatAttachment => att !== undefined);

  return { chatAttachments, workspaceRefs };
}

// Text formats analyzed as workspace files. PDFs and images are handled by
// the prefix/exact checks in toolNameForMime.
const PINCHY_READ_TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "text/yaml",
  "text/vcard",
  "text/x-vcard",
]);

/**
 * Resolve the tool an attachment of `mimeType` should be analyzed with.
 *
 * Every supported type routes through pinchy-files' own `pinchy_read` — a
 * plugin tool, NOT an OpenClaw built-in. It has a full PDF subsystem
 * (pdf-extract for the text layer; pdf-vision for scanned pages), reads images
 * as image content blocks, and resolves credentials through the runtime
 * modelAuth API, so it works on every provider/model/version. We deliberately
 * do NOT use OpenClaw's built-in `pdf`/`image` tools: they only register when
 * Pinchy emits `pdfModel`/`imageModel`, which is auto-resolved and 410s when
 * the upstream model is retired (v0.5.8 incident, #501).
 *
 * Throws on a MIME outside the documented set — the upload hint must be
 * specific, and a silent fallback would leave the agent guessing. If a new
 * attachment type is whitelisted, update this allowlist in the same change.
 */
function toolNameForMime(mimeType: string): string {
  if (
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    PINCHY_READ_TEXT_MIMES.has(mimeType)
  ) {
    return "`pinchy_read`";
  }
  throw new Error(
    `attachment-pipeline: no tool registered for MIME ${mimeType}. ` +
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
    // boundary, so the path emitted by `persistStagedUpload` cannot contain one
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
    "The user attached these files (already saved into your workspace). Read each file with the listed tool, using the exact absolute path:",
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
