/**
 * Opens a knowledge-base source file without following a link, and proves the
 * descriptor is the file the caller found, at the place it found it.
 *
 * ## Why every read goes through here
 *
 * Discovery never follows a symlink (`Dirent.isFile()` is false for one, and
 * ingest.ts skips it). Every read AFTER discovery used to follow one: the hash,
 * the PDF and spreadsheet extractors, the LibreOffice staging, the preview
 * route. So someone who can write to one mounted folder could replace
 * `report.docx`, after the walk listed it, with a link to any file the web
 * container can read — another team's folder under `/data`, an agent's
 * workspace — and that file was indexed and served under `report.docx`, to the
 * agents granted the first folder. Swapping a PARENT directory for a link has
 * the same effect, and `O_NOFOLLOW` alone cannot see it: it guards the last
 * path component only.
 *
 * ## What is checked, on the open descriptor
 *
 *   1. `O_NOFOLLOW` — a link at the last component fails the open (`ELOOP`)
 *      instead of being followed. `O_NONBLOCK` with it, so a FIFO swapped in
 *      cannot park the indexer forever in `open()`; for a regular file the
 *      flag means nothing.
 *   2. `fstat` — a regular file, and nothing else.
 *   3. The identity discovery recorded (`lstat` dev + inode), when there is
 *      one: still the same file, not something put in its place.
 *   4. Where the descriptor really is (`/proc/self/fd/N` on Linux), which must
 *      equal the real path the caller expected. This is the check that sees a
 *      swapped parent directory, wherever in the path it sits.
 *
 * Everything after this reads the returned handle — never the path again —
 * or a private copy made from it (`writePrivateCopy`), so a reader that only
 * takes a path (pdfjs, exceljs, LibreOffice) never sees one an author of the
 * share controls.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { mkdtemp, open, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** What discovery saw: the file's device and inode, from an `lstat`. */
export interface SourceIdentity {
  dev: bigint;
  ino: bigint;
}

export interface ExpectedSource {
  /**
   * The canonical path the file must be found at: the real path of its root
   * plus the path discovery walked below it. Opened directly, so a root that
   * is itself a link (an admin's `/data` mounted elsewhere, macOS's `/tmp`)
   * costs nothing, while a link anywhere BELOW the root is refused.
   */
  realPath: string;
  /** Required for ingest; absent for a request-time read, which has no discovery behind it. */
  identity?: SourceIdentity | null;
}

/**
 * Why a source was not read.
 *
 * - `link`       — the file is now a symbolic link.
 * - `not_a_file` — a directory, FIFO, socket or device now sits at the path.
 * - `replaced`   — a regular file, but not the one discovery found there.
 * - `moved`      — the descriptor is not at the expected path: a directory on
 *                  the way to it was swapped for a link.
 */
export type SourceRefusal = "link" | "not_a_file" | "replaced" | "moved";

export class SourceRefusedError extends Error {
  constructor(
    readonly refusal: SourceRefusal,
    readonly realPath: string
  ) {
    super(`refused to read ${realPath}: ${describeRefusal(refusal)}`);
    this.name = "SourceRefusedError";
  }
}

function describeRefusal(refusal: SourceRefusal): string {
  switch (refusal) {
    case "link":
      return "it is a symbolic link";
    case "not_a_file":
      return "it is not a regular file";
    case "replaced":
      return "it is no longer the file found when the folder was listed";
    case "moved":
      return "a folder on its path was replaced by a link";
  }
}

/**
 * `?? 0` because Windows has neither flag: the mask degrades to a plain read
 * there rather than turning `NaN`. Pinchy runs on Linux, and these checks are
 * what that platform gets.
 */
const OPEN_NO_FOLLOW =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

export interface VerifiedSource {
  handle: FileHandle;
  /** The descriptor's own stat, so size and mtime describe the bytes that will be read. */
  stat: BigIntStats;
}

/**
 * Opens `expected.realPath` and runs the four checks above. The caller owns the
 * returned handle and must close it.
 *
 * Errors that say nothing about a swap — the file is gone (`ENOENT`), access is
 * denied — are thrown as they are, so a caller books them the way it always
 * has. Only a refusal is a `SourceRefusedError`.
 */
export async function openVerifiedSource(expected: ExpectedSource): Promise<VerifiedSource> {
  let handle: FileHandle;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path comes from the caller's own discovery or containment check; this function is the check that makes reading it safe.
    handle = await open(expected.realPath, OPEN_NO_FOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SourceRefusedError("link", expected.realPath);
    }
    throw err;
  }

  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new SourceRefusedError("not_a_file", expected.realPath);

    if (expected.identity !== undefined) {
      const seen = expected.identity;
      if (!seen || seen.dev !== info.dev || seen.ino !== info.ino) {
        throw new SourceRefusedError("replaced", expected.realPath);
      }
    }

    if (!(await isAtPath(handle, info, expected.realPath))) {
      throw new SourceRefusedError("moved", expected.realPath);
    }

    return { handle, stat: info };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** The identity `openVerifiedSource` compares against: an `lstat`, so a link is described as itself. */
export function identityOf(info: BigIntStats): SourceIdentity {
  return { dev: info.dev, ino: info.ino };
}

/** Linux's per-process descriptor table, where each entry links to the file it is open on. */
const PROC_SELF_FD = "/proc/self/fd";

/**
 * Is the open descriptor the file at `realPath`?
 *
 * On Linux the kernel answers directly: `/proc/self/fd/N` names where the
 * descriptor really is, whatever directory was swapped on the way to it.
 *
 * Elsewhere (a developer's Mac has no procfs) the path is resolved again and
 * must still be `realPath`, and what sits there must be the very inode the
 * descriptor holds. A parent swapped before the open makes the descriptor a
 * different inode from the one at the real path; one swapped after it makes the
 * path resolve elsewhere. Either way the answer is no.
 *
 * `procSelfFd` is a seam for the tests, so the fallback is exercised on Linux
 * CI too rather than only on the machines that need it.
 */
export async function isAtPath(
  handle: FileHandle,
  info: BigIntStats,
  realPath: string,
  procSelfFd: string | null = PROC_SELF_FD
): Promise<boolean> {
  if (procSelfFd !== null) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed procfs directory plus our own descriptor number.
      return (await readlink(join(procSelfFd, String(handle.fd)))) === realPath;
    } catch {
      // No procfs here: fall through to the portable answer.
    }
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- realPath is the caller's expected path; resolving it is the check.
    if ((await realpath(realPath)) !== realPath) return false;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same path, already shown to contain no link.
    const atPath = await stat(realPath, { bigint: true });
    return atPath.dev === info.dev && atPath.ino === info.ino;
  } catch {
    return false;
  }
}

/** A private copy of a source's bytes, for readers that only take a path. */
export interface PrivateCopy {
  path: string;
  dispose(): Promise<void>;
}

/**
 * Writes `bytes` to a fresh directory only this process can enter (`mkdtemp`
 * creates it 0700), under the source's own basename.
 *
 * The basename is kept because readers dispatch on the extension and log the
 * name; the directory is fresh per copy so two `Rechnung.doc` from different
 * folders can never collide. The file is created exclusively (`wx`), so even
 * the copy cannot be a link someone prepared.
 */
export async function writePrivateCopy(
  bytes: Uint8Array,
  sourcePath: string
): Promise<PrivateCopy> {
  const dir = await mkdtemp(join(tmpdir(), "pinchy-kb-source-"));
  const name = basename(sourcePath) || randomUUID();
  const path = join(dir, name);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory mkdtemp just created for this copy.
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { path, dispose: () => rm(dir, { recursive: true, force: true }) };
}
