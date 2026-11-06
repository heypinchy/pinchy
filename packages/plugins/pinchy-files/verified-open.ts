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
 *   1. No link followed. Linux: `O_NOFOLLOW`, so a link at the last component
 *      fails (`ELOOP`) instead of being followed. macOS: `O_NOFOLLOW_ANY`,
 *      which refuses a link at ANY component — check 3, done by the kernel in
 *      the open itself. `O_NONBLOCK` so a FIFO cannot park the tool in `open()`.
 *   2. `fstat` — a regular file, nothing else.
 *   3. Linux: the descriptor's real location (`/proc/self/fd/N`) must be
 *      `realPath` — the check that sees a swapped parent folder, which
 *      `O_NOFOLLOW` cannot.
 *
 * Where neither 1 nor 3 can prove the location (no procfs, no
 * `O_NOFOLLOW_ANY`), the read is refused, never guessed: resolving the path a
 * second time is its own race, and a parent flipping between a folder and a
 * link answered "same file" for the other folder's file in 16,942 of 20,000
 * reads. The plugin runs in the Linux OpenClaw container.
 *
 * The web app has the same door for the knowledge base
 * (`packages/web/src/lib/knowledge/verified-source.ts`). It is not shared: a
 * plugin cannot import from the web bundle, and these are a few lines of fs
 * calls whose behaviour each side's own tests pin.
 */
import { constants as fsConstants, type Stats } from "fs";
import { open, readlink, type FileHandle } from "fs/promises";
import { join } from "path";

export class RefusedReadError extends Error {
  constructor(realPath: string, why: string, options?: ErrorOptions) {
    super(`Refused to read ${realPath}: ${why}`, options);
    this.name = "RefusedReadError";
  }
}

// macOS's O_NOFOLLOW_ANY (sys/fcntl.h, macOS 11+), which Node does not export.
// Darwin only — on Linux the bit means something else — and it replaces
// O_NOFOLLOW, which the kernel rejects alongside it (EINVAL).
const O_NOFOLLOW_ANY = process.platform === "darwin" ? 0x20000000 : 0;

// `?? 0`: Windows has neither flag, and the mask must not turn into NaN there.
// (Every read is then refused: Windows has no procfs either.)
const OPEN_NO_FOLLOW =
  fsConstants.O_RDONLY |
  (O_NOFOLLOW_ANY || (fsConstants.O_NOFOLLOW ?? 0)) |
  (fsConstants.O_NONBLOCK ?? 0);

/** Opens `realPath` for reading and runs the checks above. The caller closes the handle. */
export async function openVerified(
  realPath: string
): Promise<{ handle: FileHandle; stats: Stats }> {
  let handle: FileHandle;
  try {
    handle = await open(realPath, OPEN_NO_FOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new RefusedReadError(realPath, "it or a folder on its path is a symbolic link");
    }
    throw err;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new RefusedReadError(realPath, "it is not a regular file");
    // macOS: O_NOFOLLOW_ANY already refused a link at every component.
    if (!O_NOFOLLOW_ANY && !(await isAtPath(handle, realPath))) {
      throw new RefusedReadError(realPath, "a folder on its path was replaced by a symbolic link");
    }
    return { handle, stats };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/**
 * Is the open descriptor the file at `realPath`? Answered by procfs, or not at
 * all: an unreadable `/proc/self/fd` refuses the read. `procSelfFd` is a seam
 * for the tests.
 */
export async function isAtPath(
  handle: FileHandle,
  realPath: string,
  procSelfFd = "/proc/self/fd"
): Promise<boolean> {
  let location: string;
  try {
    location = await readlink(join(procSelfFd, String(handle.fd)));
  } catch (err) {
    throw new RefusedReadError(realPath, "cannot verify where the file was opened", {
      cause: err,
    });
  }
  return location === realPath;
}
