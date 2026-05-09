import { createHash } from "crypto";
import { mkdir, open, readFile } from "fs/promises";
import { join, parse as parsePath } from "path";
import { getWorkspacePath } from "@/lib/workspace";

const UPLOADS_SUBDIR = "uploads";
const MAX_COLLISION_SLOTS = 1000;

export interface PersistAttachmentParams {
  agentId: string;
  filename: string;
  buffer: Buffer;
}

export interface PersistAttachmentResult {
  relativePath: string;
  reused: boolean;
  contentHash: string;
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

  const agentWorkspace = getWorkspacePath(agentId); // throws on bad agentId
  const uploadsDir = join(agentWorkspace, UPLOADS_SUBDIR);
  await mkdir(uploadsDir, { recursive: true });

  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const { name, ext } = parsePath(filename);

  for (let i = 0; i < MAX_COLLISION_SLOTS; i++) {
    const candidate = i === 0 ? filename : `${name} (${i})${ext}`;
    const candidatePath = join(uploadsDir, candidate);

    try {
      // O_CREAT | O_EXCL — atomic create-or-fail. Wins the slot or throws EEXIST.
      const fh = await open(candidatePath, "wx");
      try {
        await fh.writeFile(buffer);
      } finally {
        await fh.close();
      }
      return {
        relativePath: `${UPLOADS_SUBDIR}/${candidate}`,
        reused: false,
        contentHash,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Existing file under this name — does it match our content?
      const existing = await readFile(candidatePath);
      if (createHash("sha256").update(existing).digest("hex") === contentHash) {
        return {
          relativePath: `${UPLOADS_SUBDIR}/${candidate}`,
          reused: true,
          contentHash,
        };
      }
      // Different content occupies this slot — try the next one.
    }
  }

  throw new Error(`Too many collisions for ${filename}`);
}
