/**
 * Opens a knowledge-base source file without following a link, and proves the
 * descriptor is a regular file at the place the caller found it.
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
 * ## What is checked
 *
 *   1. No link anywhere it may matter. On Linux, `O_NOFOLLOW`: a link at the
 *      last component fails the open (`ELOOP`) instead of being followed. On
 *      macOS, `O_NOFOLLOW_ANY`, which refuses a link at ANY component — the
 *      parent check below, done by the kernel in the open itself. `O_NONBLOCK`
 *      with either, so a FIFO swapped in cannot park the indexer forever in
 *      `open()`; for a regular file the flag means nothing.
 *   2. `fstat` — a regular file, and nothing else.
 *   3. Linux: where the descriptor really is (`/proc/self/fd/N`), which must
 *      equal the real path the caller expected. This is the check that sees a
 *      swapped parent directory, wherever in the path it sits.
 *
 * Where neither 1 nor 3 can prove the location — no procfs and no
 * `O_NOFOLLOW_ANY` — the read is refused (`SourceUnverifiableError`), never
 * guessed. Resolving the path a second time is not an answer: each walk is
 * its own race, and a parent flipping between a folder and a link answered
 * "same file" for the other folder's file in 16,942 of 20,000 reads. Pinchy
 * runs on Linux (Docker, also in development); macOS is covered for the test
 * suite and `pnpm dev`; any other platform refuses these reads.
 *
 * What is NOT checked: whether the file is the one discovery listed. A new
 * inode at the same place is what an ordinary save looks like (write a new
 * file, rename it over the old one), and on filesystems without stable inode
 * numbers (cifs `noserverino`, sshfs without `use_ino`) it is every lookup.
 * The one swap only an identity check would see — a hard link renamed into
 * place — needs the target on the same filesystem and is out of scope.
 *
 * Everything after this reads the returned handle — never the path again —
 * or a private copy streamed from it (`copyVerifiedSource`), so a reader that
 * only takes a path (pdfjs, exceljs, LibreOffice, and the child processes
 * that run them) never sees one an author of the share controls. The ingest
 * and the citation route never buffer a source: they hash it and copy it a
 * chunk at a time. The readers they hand the copy to are another matter —
 * the in-process PDF reader (`extractPdfPages`) and, until #1243 moves it
 * into a child process, the workbook reader (`readFile` in xlsx-extract.ts)
 * load that copy whole.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readlink, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";

import { hashOpenFile } from "./office-artifacts";

/**
 * Why a source was not read. Each one means the path no longer leads to a
 * regular file inside the folder it was found in:
 *
 * - `link`       — the file is now a symbolic link.
 * - `not_a_file` — a directory, FIFO, socket or device now sits at the path.
 * - `moved`      — the descriptor is not at the expected path: a directory on
 *                  the way to it was swapped for a link.
 */
export type SourceRefusal = "link" | "not_a_file" | "moved";

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
    case "moved":
      return "a folder on its path was replaced by a link";
  }
}

/**
 * This platform cannot prove where an open descriptor is (see the module
 * comment), so nothing is read. Not a `SourceRefusedError`: it says nothing
 * about the share, and is booked like any other read that failed.
 */
export class SourceUnverifiableError extends Error {
  constructor(realPath: string, options?: ErrorOptions) {
    super(`refused to read ${realPath}: cannot verify where the file was opened`, options);
    this.name = "SourceUnverifiableError";
  }
}

/**
 * macOS's `O_NOFOLLOW_ANY` (sys/fcntl.h, macOS 11+), which Node does not
 * export. Darwin only: on Linux the same bit is another flag. It replaces
 * `O_NOFOLLOW` there — the kernel rejects the two together (`EINVAL`).
 */
const O_NOFOLLOW_ANY = process.platform === "darwin" ? 0x20000000 : 0;

/**
 * `?? 0` because Windows has neither flag: the mask degrades to a plain read
 * there rather than turning `NaN` — and every read is then refused, because
 * Windows has no procfs either.
 */
const OPEN_NO_FOLLOW =
  fsConstants.O_RDONLY |
  (O_NOFOLLOW_ANY || (fsConstants.O_NOFOLLOW ?? 0)) |
  (fsConstants.O_NONBLOCK ?? 0);

export interface VerifiedSource {
  handle: FileHandle;
  /** The descriptor's own stat, so size and mtime describe the bytes that will be read. */
  stat: BigIntStats;
}

/**
 * Opens `realPath` — the real path of its root plus the path walked below it,
 * so a root that is itself a link (an admin's `/data` mounted elsewhere,
 * macOS's `/tmp`) costs nothing while a link anywhere BELOW the root is
 * refused — and runs the checks above. The caller owns the returned handle and
 * must close it.
 *
 * Errors that say nothing about a swap — the file is gone (`ENOENT`), access is
 * denied — are thrown as they are, so a caller books them the way it always
 * has. Only a refusal is a `SourceRefusedError`.
 */
export async function openVerifiedSource(realPath: string): Promise<VerifiedSource> {
  let handle: FileHandle;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path comes from the caller's own discovery or containment check; this function is the check that makes reading it safe.
    handle = await open(realPath, OPEN_NO_FOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SourceRefusedError(await whichLink(realPath), realPath);
    }
    throw err;
  }

  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new SourceRefusedError("not_a_file", realPath);
    // macOS: O_NOFOLLOW_ANY already refused a link at every component.
    if (!O_NOFOLLOW_ANY && !(await isAtPath(handle, realPath))) {
      throw new SourceRefusedError("moved", realPath);
    }
    return { handle, stat: info };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/**
 * Names the link an `ELOOP` hit: the file itself, or (macOS's
 * `O_NOFOLLOW_ANY`, or a loop of links above it on Linux) a folder on the way.
 * Only a label for the log and the audit row — the read is refused either way.
 */
async function whichLink(realPath: string): Promise<SourceRefusal> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- describes the path the open just refused; nothing is read.
  const info = await lstat(realPath).catch(() => null);
  return info === null || info.isSymbolicLink() ? "link" : "moved";
}

/** Linux's per-process descriptor table, where each entry links to the file it is open on. */
const PROC_SELF_FD = "/proc/self/fd";

/**
 * Is the open descriptor the file at `realPath`? The kernel answers:
 * `/proc/self/fd/N` names where the descriptor really is, whatever directory
 * was swapped on the way to it.
 *
 * Where that cannot be read, this throws `SourceUnverifiableError` rather than
 * answering — see the module comment for why there is no fallback.
 * `procSelfFd` is a seam for the tests.
 */
export async function isAtPath(
  handle: FileHandle,
  realPath: string,
  procSelfFd: string = PROC_SELF_FD
): Promise<boolean> {
  let location: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed procfs directory plus our own descriptor number.
    location = await readlink(join(procSelfFd, String(handle.fd)));
  } catch (err) {
    throw new SourceUnverifiableError(realPath, { cause: err });
  }
  return location === realPath;
}

/**
 * A source's hash, read through a verified descriptor and streamed
 * (`hashOpenFile`), never held whole. What the ingest compares with the hash
 * it stored, before it decides whether a source needs reading at all.
 */
export async function hashVerifiedSource(realPath: string): Promise<{ hash: string; mtime: Date }> {
  const { handle, stat: info } = await openVerifiedSource(realPath);
  try {
    return { hash: await hashOpenFile(handle), mtime: info.mtime };
  } finally {
    await handle.close();
  }
}

/** A private copy of a source, for readers that only take a path. */
export interface VerifiedCopy {
  /** The copy. The only path a reader is ever handed. */
  path: string;
  /** sha256 of exactly the bytes copied: the content hash, and the artifact key. */
  hash: string;
  size: number;
  /** The verified descriptor's mtime. */
  mtime: Date;
  dispose(): Promise<void>;
}

/**
 * Opens `realPath` through `openVerifiedSource` and streams it, a chunk at a
 * time (`SOURCE_CHUNK_BYTES`), into a fresh directory only this process can
 * enter (`mkdtemp` creates it 0700) under `stagingDir`, under the basename of
 * `sourcePath` — hashing the same chunks as it writes them. The copy never
 * holds the file whole: a 190 MB deck read whole stayed alive through its
 * conversion and embedding. (What a reader then does with the copy is its own
 * business — see the top of this file.) The descriptor is closed before this
 * returns.
 *
 * `stagingDir` is the artifact volume's `staging/` (`stagingDirOf`, or a
 * request's `liveStagingDirOf`, in office-artifacts.ts), not `os.tmpdir()`: a
 * run killed mid-copy — a restart, an upgrade, an OOM kill — never reaches
 * `dispose()`, and on the container's writable layer a full plaintext copy of
 * a document would survive every restart. On the volume, the index worker
 * clears it at start (`clearStagedBatches`).
 *
 * The basename is kept because readers dispatch on the extension and log the
 * name; the directory is fresh per copy so two `Rechnung.doc` from different
 * folders can never collide. The file is created exclusively (`wx`), so even
 * the copy cannot be a link someone prepared.
 */
export async function copyVerifiedSource(
  realPath: string,
  sourcePath: string,
  stagingDir: string
): Promise<VerifiedCopy> {
  const source = await openVerifiedSource(realPath);
  try {
    return await copyOpenSource(source, sourcePath, stagingDir);
  } finally {
    await source.handle.close();
  }
}

/**
 * `copyVerifiedSource` for a descriptor the caller has already opened through
 * `openVerifiedSource` — the preview route, which tells a refused open apart
 * from a copy that could not be written. The caller still owns, and closes,
 * the descriptor.
 */
export async function copyOpenSource(
  source: VerifiedSource,
  sourcePath: string,
  stagingDir: string
): Promise<VerifiedCopy> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the artifact volume's staging directory, from configuration.
  await mkdir(stagingDir, { recursive: true });
  const dir = await mkdtemp(join(stagingDir, "source-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const path = join(dir, basename(sourcePath) || randomUUID());
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory mkdtemp just created for this copy.
    const copy = await open(path, "wx", 0o600);
    let size = 0;
    let hash: string;
    try {
      hash = await hashOpenFile(source.handle, async (chunk) => {
        // A write may take less than it was given; the rest follows.
        for (let at = 0; at < chunk.length;) at += (await copy.write(chunk, at)).bytesWritten;
        size += chunk.length;
      });
    } finally {
      await copy.close();
    }
    return { path, hash, size, mtime: source.stat.mtime, dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}
