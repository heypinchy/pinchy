/**
 * Artifact store for Office documents converted to PDF (#936).
 *
 * The converted PDF must NOT be written next to the original: `/data` is
 * mounted read-only into the web container and the docs state that as a
 * product promise, not an implementation detail. So converted artifacts live
 * on their own volume — the precedent is `pinchy-pdf-cache`
 * (/var/cache/pinchy-files) in the OpenClaw container, mirrored here as
 * `pinchy-kb-artifacts` (/var/cache/pinchy-kb-artifacts) for the web tier.
 *
 * ## The key, and the one deviation from PdfCache
 *
 * `PdfCache` keys on path + size + mtime + content hash + format_version, with
 * a size/mtime fast path so it can answer without hashing a large PDF. This
 * store keys on **format_version + content hash only**, and that is a
 * deliberate simplification rather than a shortcut: the KB ingest pipeline
 * ALREADY hashes every file's bytes for its own idempotency check, so the hash
 * is free at the call site here. Keying on it directly means
 *
 *   - no staleness window at all (size+mtime can collide; content cannot),
 *   - two copies of the same document convert once — and the Noack corpus
 *     really does contain the same discussion guide as both `.doc` and
 *     `.docx`,
 *   - the source path never appears in the store, so a shared artifact volume
 *     leaks nothing about the corpus layout.
 *
 * `format_version` is the part that carries over unchanged, and it is the one
 * that matters: improving the converter must invalidate everything. It is a
 * path segment (`<root>/v3/ab/abcd….pdf`) rather than a stored column so a
 * bump is visible in `ls`, and superseding a version is one directory removal
 * (`pruneOtherFormatVersions`) instead of a table scan.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, type Dirent } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * sha256 of a file's bytes, streamed through `hashOpenFile` — the
 * artifact-store key.
 *
 * Lives here rather than in `office-convert.ts` because computing the key is
 * the store's business, and because the preview route (#939) needs it without
 * importing a module that spawns LibreOffice and loads pdfjs. The ingest
 * pipeline already hashes every file for its own idempotency check and should
 * pass that hash rather than pay for a second read.
 *
 * By path, so only for a path the caller already trusts — the converter's own
 * input, which the ingest makes a private copy. A source on a share is hashed
 * through its verified descriptor instead (verified-source.ts).
 */
export async function hashFileContents(absPath: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- absPath is a source the caller vouches for (the converter's own input); every knowledge-base read of the share goes through verified-source.ts instead.
  const handle = await open(absPath, "r");
  try {
    return await hashOpenFile(handle);
  } finally {
    await handle.close();
  }
}

/**
 * How much of a source this process holds at once while it hashes or copies
 * one. Never the whole file: a 190 MB deck held whole stayed alive through its
 * conversion and its embedding.
 */
export const SOURCE_CHUNK_BYTES = 64 * 1024;

/**
 * The same key, read through a descriptor the caller has already opened and
 * verified (verified-source.ts) — so the bytes hashed are the bytes of the
 * file that passed the check, not of whatever the path names by now.
 *
 * One buffer of `SOURCE_CHUNK_BYTES`, reused: the file is never held whole.
 * `eachChunk` sees every chunk, in order, before the next one is read — how
 * `copyVerifiedSource` writes its copy in the same pass that hashes it. The
 * chunk is only valid until `eachChunk` settles. Positional reads: the
 * handle's own offset is left where it was.
 *
 * `maxBytes` stops the read there, however far the file runs past it — a file
 * still being written is not followed.
 */
export async function hashOpenFile(
  handle: FileHandle,
  eachChunk?: (chunk: Buffer) => Promise<unknown>,
  maxBytes: number = Infinity
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(SOURCE_CHUNK_BYTES);
  for (let position = 0; position < maxBytes;) {
    const want = Math.min(buffer.length, maxBytes - position);
    const { bytesRead } = await handle.read(buffer, 0, want, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    await eachChunk?.(chunk);
    position += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * Bump this whenever a change makes the converter produce a materially
 * different PDF for the same input — a different LibreOffice major version, a
 * changed filter or font set, a different `--convert-to` invocation, a change
 * to what the preflight lets through. Every stored artifact is invalidated,
 * and #939's preview serves the new output.
 *
 * The store alone does not get an unchanged document there: its hash matches
 * and it has chunks, so the ingest never asks for its artifact. The ingest
 * records this version on each Office document's row and converts and reads
 * again every document whose version is not this one (ingest.ts), so after a
 * bump the artifact a citation opens AND the chunks the search finds both come
 * from the current rules — once per document. Until then the search leaves
 * such a document's chunks out, and the index worker queues the run at boot
 * (office-format-upgrade.ts).
 *
 * 2: the preflight's relationship allow-list. An artifact converted without it
 * may hold what an altChunk or an SVG picture read from the server's disk, and
 * so may the chunks read from it.
 */
export const OFFICE_ARTIFACT_FORMAT_VERSION = 2;

/**
 * Where converted artifacts live. Overridable so a dev machine (and the test
 * suite) can point it somewhere writable; in the container this is the
 * `pinchy-kb-artifacts` volume.
 */
export const DEFAULT_ARTIFACT_DIR = process.env.KB_ARTIFACT_DIR || "/var/cache/pinchy-kb-artifacts";

/** How long an artifact survives without being read. Mirrors PdfCache's 7 days. */
export const DEFAULT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Scratch space for in-flight batches, alongside the version directories. */
const STAGING_DIR_NAME = "staging";

/**
 * The store's scratch directory, for work that must stay off the container's
 * writable layer — the conversion's batches, and the private copies of the
 * sources it reads (verified-source.ts `copyVerifiedSource`). Whatever a
 * killed run leaves here, `clearStagedBatches` removes at the next start.
 */
export function stagingDirOf(rootDir: string = DEFAULT_ARTIFACT_DIR): string {
  return join(rootDir, STAGING_DIR_NAME);
}

/**
 * This process's own corner of `staging/`, which `clearStagedBatches` spares:
 * for the copies a REQUEST makes (the preview route's), which can be in use
 * while the index worker's boot clear runs — the server takes requests before
 * the worker's first tick. Another process's corner is a dead one's and is
 * cleared like any batch.
 *
 * Named by an id held on `globalThis`, not in this module: Next.js bundles a
 * route handler apart from the server that starts the worker, so each has its
 * own copy of this module — and must still agree on which corner is theirs.
 */
export function liveStagingDirOf(rootDir: string = DEFAULT_ARTIFACT_DIR): string {
  return join(rootDir, STAGING_DIR_NAME, liveStagingName());
}

const LIVE_STAGING_ID = Symbol.for("pinchy.kb.liveStagingId");

function liveStagingName(): string {
  const registry = globalThis as { [LIVE_STAGING_ID]?: string };
  registry[LIVE_STAGING_ID] ??= randomUUID();
  return `live-${registry[LIVE_STAGING_ID]}`;
}

export interface OfficeArtifactStoreOptions {
  formatVersion?: number;
}

export class OfficeArtifactStore {
  readonly rootDir: string;
  readonly formatVersion: number;
  private readonly versionDir: string;

  constructor(rootDir: string = DEFAULT_ARTIFACT_DIR, options: OfficeArtifactStoreOptions = {}) {
    this.rootDir = rootDir;
    this.formatVersion = options.formatVersion ?? OFFICE_ARTIFACT_FORMAT_VERSION;
    this.versionDir = join(rootDir, `v${this.formatVersion}`);
    mkdirSync(this.versionDir, { recursive: true });
  }

  /**
   * Absolute path the artifact for `contentHash` lives at. A pure function of
   * the key — #939 resolves a preview request through this without needing to
   * know whether the conversion has happened yet.
   *
   * The hash is re-hashed rather than used verbatim so a caller passing
   * something path-shaped can never escape the store; the first two characters
   * fan out into 256 subdirectories, because a single flat directory with tens
   * of thousands of entries is slow on every filesystem that matters.
   */
  pathFor(contentHash: string): string {
    const key = createHash("sha256").update(contentHash).digest("hex");
    return join(this.versionDir, key.slice(0, 2), `${key}.pdf`);
  }

  /**
   * The stored artifact for `contentHash`, or null.
   *
   * A hit TOUCHES the file. Without that, `sweep` would delete exactly the
   * artifacts the corpus depends on most: an unchanged document is never
   * re-converted, so its artifact's mtime would keep aging while every reindex
   * keeps reading it.
   */
  async get(contentHash: string): Promise<string | null> {
    const path = this.pathFor(contentHash);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size === 0) return null;
    } catch {
      return null;
    }
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return path;
  }

  /**
   * Takes ownership of a freshly converted PDF, moving it into the store and
   * returning its final path. The move is the commit point: an artifact only
   * becomes visible once conversion AND verification are behind it, so a
   * reader can never be handed a half-written file.
   *
   * office-convert hands it a private copy staged inside the store, so this is
   * normally a rename on one volume. A path on another volume — `rename()`
   * cannot cross one (EXDEV) — is copied to a temporary name beside the
   * artifact and renamed from there, so the commit is still one atomic rename,
   * inside the store.
   */
  async put(contentHash: string, stagedPdfPath: string): Promise<string> {
    const path = this.pathFor(contentHash);
    await mkdir(join(path, ".."), { recursive: true });
    await rm(path, { force: true });
    try {
      await rename(stagedPdfPath, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await copyFile(stagedPdfPath, temporary);
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      await rm(stagedPdfPath, { force: true });
    }
    return path;
  }

  /**
   * A fresh scratch directory for one conversion batch, on the SAME filesystem
   * as the store. That is not tidiness: `put()` commits with `rename()`, which
   * fails with EXDEV across mount points — and in the container `os.tmpdir()`
   * and the artifact volume are exactly that. Staging here also keeps the
   * batch's intermediate PDFs off the container's writable layer.
   */
  async createStagingDir(): Promise<string> {
    const dir = join(this.rootDir, STAGING_DIR_NAME, randomUUID());
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Deletes artifacts not read for longer than `maxAgeMs`. Returns how many. */
  async sweep(maxAgeMs: number = DEFAULT_ARTIFACT_TTL_MS): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const shard of await this.listDir(this.versionDir)) {
      const shardDir = join(this.versionDir, shard);
      for (const name of await this.listDir(shardDir)) {
        const path = join(shardDir, name);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile() || info.mtimeMs >= cutoff) continue;
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }

  /** readdir that answers [] for a directory that does not exist yet. */
  private async listDir(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }
}

/**
 * Removes every batch directory under `<rootDir>/staging/` and returns how
 * many there were.
 *
 * A batch removes its own directory when it finishes, but one that never
 * finishes — a restart, an upgrade, an OOM kill during the nightly reindex —
 * leaves its checked copies behind (up to `OFFICE_CONVERT_BATCH_SIZE` of them,
 * each up to 200 MB), and nothing else ever reads `staging/`: `sweep` walks
 * the version directory and `pruneOtherFormatVersions` skips it on purpose.
 *
 * Only safe while no batch can be running: the index worker calls it once at
 * boot, before its first claim — the same single-container premise
 * `requeueOrphanedIndexJobs` rests on. The conversion and the ingest's private
 * source copies (`stagingDirOf`) write to `staging/` only from the worker. The
 * one writer that is not the worker — a preview's copy of the workbook it
 * reads — writes to this process's own corner (`liveStagingDirOf`), which is
 * spared.
 *
 * A function of the directory rather than a store method so clearing needs no
 * store: constructing one creates the version directory, and a volume that is
 * missing should cost nothing here.
 */
export async function clearStagedBatches(rootDir: string = DEFAULT_ARTIFACT_DIR): Promise<number> {
  const stagingDir = join(rootDir, STAGING_DIR_NAME);
  let batches: string[];
  try {
    batches = await readdir(stagingDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const own = liveStagingName();
  const dead = batches.filter((batch) => batch !== own);
  for (const batch of dead) {
    await rm(join(stagingDir, batch), { recursive: true, force: true });
  }
  return dead.length;
}

/**
 * Removes every artifact of a format version other than `keepVersion` that no
 * document is still on record as read from, and returns how many there were.
 *
 * After a bump nothing reads them again — `pathFor` resolves only the current
 * version, so the preview cannot reach them — but they still hold whatever the
 * earlier, weaker conversion drew into its PDFs, and they cost disk. A version
 * stays, though, while `inUse(version)` says a document's chunks were read
 * from it: that document has not been converted again yet (the ingest does
 * that on its next run, and the index worker queues the run at boot), and its
 * directory is what a rollback to that version — the database restored, the
 * artifact volume not — would still need. The index worker asks at boot and
 * after every run, so a version goes once its last document has moved on.
 *
 * Deletes only real directories named `v<n>` directly under `rootDir`: never
 * `staging/` (a batch may be converting into it), never a symlink, whatever
 * it is named. A function of the directory for the same reason as
 * `clearStagedBatches`: a store would create its version directory, and a
 * missing volume should cost nothing here.
 */
export async function pruneOtherFormatVersions(
  rootDir: string = DEFAULT_ARTIFACT_DIR,
  keepVersion: number = OFFICE_ARTIFACT_FORMAT_VERSION,
  inUse: (version: number) => Promise<boolean>
): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^v\d+$/.test(entry.name)) continue;
    const version = Number(entry.name.slice(1));
    if (version === keepVersion) continue;
    if (await inUse(version)) continue;
    const dir = join(rootDir, entry.name);
    for (const shard of await readdir(dir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      removed += (await readdir(join(dir, shard.name))).length;
    }
    // `rm` removes a symlink inside the tree, never what it points at.
    await rm(dir, { recursive: true, force: true });
  }
  return removed;
}

let sharedStore: OfficeArtifactStore | null = null;

/**
 * The process-wide store. Lazy on purpose: constructing one creates its
 * directory, and importing this module must not touch the filesystem (the web
 * process imports it on paths that never convert anything).
 */
export function getOfficeArtifactStore(): OfficeArtifactStore {
  sharedStore ??= new OfficeArtifactStore();
  return sharedStore;
}
