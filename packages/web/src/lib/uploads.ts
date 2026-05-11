import { createHash, randomBytes, randomUUID } from "crypto";
import { link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "fs/promises";
import { join, parse as parsePath } from "path";
import { getWorkspacePath } from "@/lib/workspace";
import { sanitizeFilename } from "@/lib/upload-validation";

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
 * Returns the first available filename in `dir` for the given `filename`.
 *
 * Tries `filename` first, then `<name> (1)<ext>`, `<name> (2)<ext>`, etc.
 * A slot is "available" when no file exists at that path. Throws
 * `UploadSlotExhaustedError` if no free slot is found within `maxCollisions`
 * tries.
 *
 * Used by `promoteStagedToAttached` to find the first free slot before
 * renaming a staged file into `uploads/`.
 *
 * NOT used by `persistAttachment`: that function has its own inline loop with
 * content-hash dedup semantics (it returns `reused: true` when an existing
 * file's content matches the incoming buffer, which requires reading each
 * candidate to compare hashes — a different behavior that cannot be delegated
 * to this helper).
 */
async function buildNextFreeFilename(
  dir: string,
  filename: string,
  maxCollisions = DEFAULT_MAX_COLLISION_SLOTS
): Promise<string> {
  const { name, ext } = parsePath(filename);
  for (let i = 0; i < maxCollisions; i++) {
    const candidate = i === 0 ? filename : `${name} (${i})${ext}`;
    try {
      // O_CREAT | O_EXCL — atomic probe; close immediately, caller writes/renames.
      const fh = await open(join(dir, candidate), "wx");
      await fh.close();
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Slot is taken — try the next suffix.
    }
  }
  throw new UploadSlotExhaustedError(filename, maxCollisions);
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

export interface PromoteParams {
  workspaceRoot: string;
  stagedRelativePath: string; // e.g. ".staging/<uploadId>/<filename>"
  filename: string; // the filename to use in the durable uploads/ dir
}

export interface PromotedRef {
  relativePath: string; // e.g. "uploads/doc.pdf"
}

/**
 * Atomically moves a staged file to its durable `uploads/` path.
 *
 * Steps:
 * 1. Resolve the absolute path of the staged file.
 * 2. Ensure `uploads/` dir exists.
 * 3. Use `buildNextFreeFilename` to find a free slot (collision-suffixed if
 *    needed), which creates an empty placeholder file via `O_CREAT | O_EXCL`.
 * 4. `rename` the staged file over the placeholder — atomic on the same FS.
 * 5. Remove the `.staging/<uploadId>/` directory.
 * 6. Return `{ relativePath: "uploads/<targetName>" }`.
 */
export async function promoteStagedToAttached(params: PromoteParams): Promise<PromotedRef> {
  const { workspaceRoot, stagedRelativePath } = params;
  const filename = sanitizeFilename(params.filename);

  // Extract uploadId from ".staging/<uploadId>/<filename>"
  const parts = stagedRelativePath.split("/");
  const uploadId = parts[1];

  const stagedAbsPath = join(workspaceRoot, stagedRelativePath);
  const uploadsDir = join(workspaceRoot, UPLOADS_SUBDIR);
  await mkdir(uploadsDir, { recursive: true });

  // Find (and atomically reserve) a free slot
  const targetName = await buildNextFreeFilename(uploadsDir, filename);
  const targetAbsPath = join(uploadsDir, targetName);

  // rename is atomic on the same filesystem; overwrites the placeholder
  await rename(stagedAbsPath, targetAbsPath);

  // Clean up the staging directory for this upload
  const stagingDir = join(workspaceRoot, ".staging", uploadId);
  await rm(stagingDir, { recursive: true, force: true });

  return { relativePath: `${UPLOADS_SUBDIR}/${targetName}` };
}

export interface PersistStagedUploadParams {
  workspaceRoot: string;
  filename: string;
  buffer: Buffer;
}

export interface StagedUploadRef {
  uploadId: string;
  relativePath: string;
  contentHash: string;
}

/**
 * Writes the buffer to `<workspaceRoot>/.staging/<uploadId>/<filename>`.
 *
 * Each call generates a fresh UUID for the staging directory, so concurrent
 * uploads of the same filename never collide. This is the first phase of the
 * two-phase upload flow; the file is promoted to its durable path later.
 */
export async function persistStagedUpload(
  params: PersistStagedUploadParams
): Promise<StagedUploadRef> {
  const { workspaceRoot, filename, buffer } = params;
  const safeName = sanitizeFilename(filename);
  const uploadId = randomUUID();
  const stagingDir = join(workspaceRoot, ".staging", uploadId);
  await mkdir(stagingDir, { recursive: true });
  await writeFile(join(stagingDir, safeName), buffer);
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  return {
    uploadId,
    relativePath: `.staging/${uploadId}/${safeName}`,
    contentHash,
  };
}
