import { createHash, randomUUID } from "crypto";
import { mkdir, open, rename, rm, writeFile } from "fs/promises";
import { join, parse as parsePath } from "path";
import { sanitizeFilename } from "@/lib/upload-validation";

const UPLOADS_SUBDIR = "uploads";
const DEFAULT_MAX_COLLISION_SLOTS = 1000;

/**
 * Thrown when no free slot is found in `uploads/` for a given filename
 * within `maxCollisions` tries. Surfaces an actionable message instead of a
 * generic "internal error" so the user can rename the file or clean up
 * stale uploads.
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
 * Returns the first available filename in `dir` for the given `filename` and
 * atomically reserves it by creating an empty placeholder via
 * `O_CREAT | O_EXCL`. Tries `filename`, then `<name> (1)<ext>`,
 * `<name> (2)<ext>`, ... up to `maxCollisions`. Throws
 * `UploadSlotExhaustedError` if every slot is taken.
 *
 * Used by `persistStagedUpload` to lock in the eventual `uploads/<name>`
 * slot at upload time, so the client's preview URL is already non-colliding
 * by the time POST /uploads returns.
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

export interface PromoteParams {
  workspaceRoot: string;
  stagedRelativePath: string; // e.g. ".staging/<uploadId>/<filename>"
  filename: string; // the reserved uploads/ filename (already collision-free)
}

export interface PromotedRef {
  relativePath: string; // e.g. "uploads/doc.pdf"
}

/**
 * Atomically moves a staged file to its durable `uploads/` path.
 *
 * The destination slot was reserved at stage time by `persistStagedUpload`
 * via `O_CREAT | O_EXCL`, so this function does NOT need to probe for a
 * free filename — the reservation is already there as an empty placeholder,
 * and `rename` overwrites it atomically.
 */
export async function promoteStagedToAttached(params: PromoteParams): Promise<PromotedRef> {
  const { workspaceRoot, stagedRelativePath } = params;
  const filename = sanitizeFilename(params.filename);

  // Extract uploadId from ".staging/<uploadId>/<filename>"
  const parts = stagedRelativePath.split("/");
  const uploadId = parts[1];

  const stagedAbsPath = join(workspaceRoot, stagedRelativePath);
  const uploadsDir = join(workspaceRoot, UPLOADS_SUBDIR);
  const targetAbsPath = join(uploadsDir, filename);

  // Belt-and-braces: persistStagedUpload normally creates uploads/ when it
  // reserves the slot, but tests (and any direct caller skipping the staging
  // helper) may seed rows without the placeholder. Without this mkdir, rename
  // throws ENOENT for the missing directory in those code paths.
  await mkdir(uploadsDir, { recursive: true });

  // rename is atomic on the same filesystem; overwrites the placeholder that
  // persistStagedUpload created at upload time (or creates a fresh file when
  // the placeholder is absent — same end state).
  await rename(stagedAbsPath, targetAbsPath);

  // Clean up the staging directory for this upload
  const stagingDir = join(workspaceRoot, ".staging", uploadId);
  await rm(stagingDir, { recursive: true, force: true });

  return { relativePath: `${UPLOADS_SUBDIR}/${filename}` };
}

export interface PersistStagedUploadParams {
  workspaceRoot: string;
  filename: string;
  buffer: Buffer;
}

export interface StagedUploadRef {
  uploadId: string;
  /** Final filename to be used in `uploads/`. Collision-suffixed if needed. */
  filename: string;
  /** Path to the staged file: `.staging/<uploadId>/<filename>`. */
  relativePath: string;
  contentHash: string;
}

/**
 * Stages an upload AND atomically reserves its eventual `uploads/<name>` slot
 * in one step:
 *
 * 1. Walk `name`, `name (1)`, `name (2)`, ... in `uploads/` and create the
 *    first free entry via `O_CREAT | O_EXCL` (the placeholder).
 * 2. Write the file into `.staging/<uploadId>/<reservedName>` for later
 *    promotion via `rename` over the placeholder.
 *
 * Reserving up front (instead of at promote time) means the
 * `/api/agents/<id>/uploads/<reservedName>` URL the client gets back from the
 * POST response is already collision-free — no broken chip preview while the
 * file sits in staging and no rename surprises at send time.
 *
 * `filename` must already be sanitized by the caller via `sanitizeFilename`.
 */
export async function persistStagedUpload(
  params: PersistStagedUploadParams
): Promise<StagedUploadRef> {
  const { workspaceRoot, filename, buffer } = params;

  // 1. Reserve a free slot in uploads/ via O_CREAT | O_EXCL.
  const uploadsDir = join(workspaceRoot, UPLOADS_SUBDIR);
  await mkdir(uploadsDir, { recursive: true });
  const reservedFilename = await buildNextFreeFilename(uploadsDir, filename);

  // 2. Write the file to staging under the SAME reserved name so promote is a
  //    plain rename without filename juggling.
  const uploadId = randomUUID();
  const stagingDir = join(workspaceRoot, ".staging", uploadId);
  await mkdir(stagingDir, { recursive: true });
  await writeFile(join(stagingDir, reservedFilename), buffer);

  const contentHash = createHash("sha256").update(buffer).digest("hex");
  return {
    uploadId,
    filename: reservedFilename,
    relativePath: `.staging/${uploadId}/${reservedFilename}`,
    contentHash,
  };
}
