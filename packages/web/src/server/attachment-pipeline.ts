import type { ChatAttachment } from "openclaw-node";
import { sanitizeFilename, validateUploadBuffer } from "@/lib/upload-validation";
import { persistAttachment } from "@/lib/uploads";
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
    if (part.type !== "image_url" || !part.image_url?.url) continue;
    const match = part.image_url.url.match(DATA_URL_RE);
    if (!match) continue;

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
      const ref = await persistAttachment({ agentId, filename: safeName, buffer });
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

// Filenames are sanitized server-side, but `sanitizeFilename` permits backticks
// (rare-but-legal in real filenames). When the path is interpolated into a
// markdown code span in the system prompt, an embedded backtick would close
// the span and let user-supplied text leak into the prompt structure.
// Replace `` ` `` with the visually-similar U+02BC MODIFIER LETTER APOSTROPHE
// so the path stays readable to the agent and the code span stays balanced.
function escapeForMarkdownCodeSpan(s: string): string {
  return s.replace(/`/g, "ʼ");
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

export function buildUploadHint(refs: ProcessedWorkspaceRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((r) => {
    const path = escapeForMarkdownCodeSpan(r.absolutePath);
    const tool = toolNameForMime(r.mimeType);
    return `- \`${path}\` (${r.mimeType}, ${formatBytes(r.sizeBytes)}) — analyze with ${tool}`;
  });
  return [
    "## User uploaded files",
    "The user uploaded these files into the agent workspace. Use the listed built-in tool with the exact absolute path to analyze each file:",
    ...lines,
    "",
    "If you delegate this task to a sub-agent or another tool, pass the exact paths from the list above — do not retype from memory.",
  ].join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
