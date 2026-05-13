import { createHash, randomBytes } from "crypto";
import { link, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { join, parse as parsePath } from "path";
import { getWorkspacePath } from "@/lib/workspace";

const UPLOADS_SUBDIR = "uploads";
const DEFAULT_MAX_COLLISION_SLOTS = 1000;

export interface PersistAttachmentParams {
  agentId: string;
  filename: string;
  buffer: Buffer;
  /**
   * Maximum number of `<name> (N).<ext>` slots to try before giving up with
   * `UploadSlotExhaustedError`. Defaults to 1000. Exposed mainly so tests can
   * exercise the exhaustion path without writing thousands of files; in
   * production this should always use the default.
   */
  maxCollisions?: number;
}

export interface PersistAttachmentResult {
  relativePath: string;
  reused: boolean;
  contentHash: string;
}

/**
 * Thrown when `persistAttachment` cannot find a free slot for a filename
 * with *different* content from every existing slot, within `maxCollisions`
 * tries. This is a client-input problem (uploading thousands of distinct
 * files under the same filename) — the caller maps it to a typed
 * validation error so the user sees an actionable message instead of a
 * generic "internal error". Carrying `filename` lets the caller include
 * it in the user-facing string.
 */
export class UploadSlotExhaustedError extends Error {
  constructor(
    public readonly filename: string,
    public readonly maxCollisions: number
  ) {
    super(
      `Too many existing files share the name "${filename}". ` +
        `Tried ${maxCollisions} alternative slots without finding a free one. ` +
        `Rename the file or remove old uploads from the agent workspace.`
    );
    this.name = "UploadSlotExhaustedError";
  }
}

/**
 * Writes the buffer to `<workspace>/<agentId>/uploads/<filename>`.
 *
 * - If the target slot is free, writes there.
 * - If the slot is taken by identical content, returns `reused: true`.
 * - If the slot is taken by *different* content, tries `<name> (1)<ext>`,
 *   `<name> (2)<ext>`, ... up to `MAX_COLLISION_SLOTS`.
 *
 * Concurrency-safe: each candidate is opened with `O_CREAT | O_EXCL` (`wx`),
 * so two concurrent writers of *different* content under the same filename
 * can never clobber each other — the loser of the race sees `EEXIST`,
 * compares hashes, and either dedups or moves to the next slot.
 *
 * All FS work uses `fs/promises` so the event loop stays responsive while
 * hashing and writing the (up to 15 MB) attachment.
 */
export async function persistAttachment(
  params: PersistAttachmentParams
): Promise<PersistAttachmentResult> {
  const { agentId, filename, buffer } = params;
  const maxCollisions = params.maxCollisions ?? DEFAULT_MAX_COLLISION_SLOTS;

  const agentWorkspace = getWorkspacePath(agentId); // throws on bad agentId
  const uploadsDir = join(agentWorkspace, UPLOADS_SUBDIR);
  await mkdir(uploadsDir, { recursive: true });

  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const { name, ext } = parsePath(filename);

  for (let i = 0; i < maxCollisions; i++) {
    const candidate = i === 0 ? filename : `${name} (${i})${ext}`;
    const candidatePath = join(uploadsDir, candidate);

    // Write to a unique temp file first, then atomically hard-link it to the
    // slot. `link(tmp, final)` succeeds only when `final` does not exist —
    // and crucially, it only runs AFTER the temp file is fully written. This
    // closes the TOCTOU window where a concurrent caller could `open(slot,
    // "wx")` first but then race the `EEXIST`-loser's `readFile(slot)` on an
    // empty file (mis-deduping to a fresh slot instead of joining).
    const tmpName = `.${candidate}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    const tmpPath = join(uploadsDir, tmpName);
    await writeFile(tmpPath, buffer);

    try {
      await link(tmpPath, candidatePath);
      return {
        relativePath: `${UPLOADS_SUBDIR}/${candidate}`,
        reused: false,
        contentHash,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Slot taken. Because `link` only succeeds after the winner's temp file
      // was fully written, `candidatePath` is guaranteed to hold the winner's
      // complete content — safe to read and compare hashes.
      const existing = await readFile(candidatePath);
      if (createHash("sha256").update(existing).digest("hex") === contentHash) {
        return {
          relativePath: `${UPLOADS_SUBDIR}/${candidate}`,
          reused: true,
          contentHash,
        };
      }
      // Different content occupies this slot — try the next one.
    } finally {
      // Clean up the temp file in all paths. On the success branch, the inode
      // still lives via the hard link at `candidatePath`; we are only removing
      // the extra name, not the content.
      await unlink(tmpPath).catch(() => {});
    }
  }

  throw new UploadSlotExhaustedError(filename, maxCollisions);
}
