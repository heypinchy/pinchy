/**
 * Opens a file the read tools have already resolved and validated, without
 * following a link, and proves the descriptor is the file at that path.
 *
 * `pinchy_read` realpaths the requested path and checks the RESULT against the
 * agent's paths (`validateAccess`). That check sees a link already in place.
 * It cannot see one put in place after it: a plain `open(realPath)` follows
 * whatever sits at the path by then — the file itself swapped for a link, or a
 * folder on the way to it — and returns another team's file under this name.
 * So the read happens on a descriptor opened here, and nowhere else:
 *
 *   1. `O_NOFOLLOW` — a link at the last component fails (`ELOOP`) instead of
 *      being followed. `O_NONBLOCK` so a FIFO cannot park the tool in `open()`.
 *   2. `fstat` — a regular file, nothing else.
 *   3. The descriptor's real location (`/proc/self/fd/N` on Linux) must be
 *      `realPath` — the check that sees a swapped parent folder, which
 *      `O_NOFOLLOW` cannot. Elsewhere the path is resolved again and must still
 *      name the very inode the descriptor holds.
 *
 * The web app has the same door for the knowledge base
 * (`packages/web/src/lib/knowledge/verified-source.ts`). It is not shared: a
 * plugin cannot import from the web bundle, and these are a few lines of fs
 * calls whose behaviour each side's own tests pin.
 */
import { constants as fsConstants, type Stats } from "fs";
import { open, readlink, realpath, stat, type FileHandle } from "fs/promises";
import { join } from "path";

export class RefusedReadError extends Error {
  constructor(realPath: string, why: string) {
    super(`Refused to read ${realPath}: ${why}`);
    this.name = "RefusedReadError";
  }
}

// `?? 0`: Windows has neither flag, and the mask must not turn into NaN there.
const OPEN_NO_FOLLOW =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Opens `realPath` for reading and runs the three checks above. The caller closes the handle. */
export async function openVerified(
  realPath: string
): Promise<{ handle: FileHandle; stats: Stats }> {
  let handle: FileHandle;
  try {
    handle = await open(realPath, OPEN_NO_FOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new RefusedReadError(realPath, "it was replaced by a symbolic link");
    }
    throw err;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new RefusedReadError(realPath, "it is not a regular file");
    if (!(await isAtPath(handle, stats, realPath))) {
      throw new RefusedReadError(realPath, "a folder on its path was replaced by a symbolic link");
    }
    return { handle, stats };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function isAtPath(handle: FileHandle, stats: Stats, realPath: string): Promise<boolean> {
  try {
    return (await readlink(join("/proc/self/fd", String(handle.fd)))) === realPath;
  } catch {
    // No procfs (a developer's Mac): fall through to the portable answer.
  }
  try {
    if ((await realpath(realPath)) !== realPath) return false;
    const atPath = await stat(realPath);
    return atPath.dev === stats.dev && atPath.ino === stats.ino;
  } catch {
    return false;
  }
}
