/**
 * OfficeArtifactStore: the on-disk home of converted Office PDFs.
 *
 * The two properties worth a test are the ones a wrong answer makes invisible:
 * a bumped format_version must invalidate EVERYTHING (otherwise improving the
 * converter silently keeps serving the old output forever), and nothing may
 * ever be written next to the original (`/data` is mounted read-only and the
 * docs state that as a product promise).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { readdir, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearStagedBatches,
  liveStagingDirOf,
  OfficeArtifactStore,
  pruneOtherFormatVersions,
  SCAN_ARTIFACT_FORMAT_VERSION,
  scanArtifactDirOf,
} from "@/lib/knowledge/office-artifacts";

let tmpRoot: string;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-artifacts-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Writes a stand-in "converted PDF" the store can take ownership of. */
function stagedPdf(name: string, body = "%PDF-1.4 stand-in"): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, body);
  return path;
}

describe("OfficeArtifactStore", () => {
  it("stores an artifact and returns it for the same content hash", async () => {
    const store = new OfficeArtifactStore(join(tmpRoot, "store"));

    expect(await store.get(HASH_A)).toBeNull();

    const stored = await store.put(HASH_A, stagedPdf("staged.pdf", "%PDF-1.4 first"));

    expect(await store.get(HASH_A)).toBe(stored);
    expect(readFileSync(stored, "utf8")).toBe("%PDF-1.4 first");
    // The staged file was MOVED, not copied: nothing accumulates in the
    // caller's temp dir.
    expect(existsSync(join(tmpRoot, "staged.pdf"))).toBe(false);
  });

  it("never returns one document's artifact for another document's content", async () => {
    const store = new OfficeArtifactStore(join(tmpRoot, "store"));
    await store.put(HASH_A, stagedPdf("a.pdf"));

    expect(await store.get(HASH_B)).toBeNull();
  });

  it("invalidates every stored artifact when the format version is bumped", async () => {
    const root = join(tmpRoot, "store");
    const v1 = new OfficeArtifactStore(root, { formatVersion: 1 });
    await v1.put(HASH_A, stagedPdf("a.pdf"));
    expect(await v1.get(HASH_A)).not.toBeNull();

    // Same root, same content, improved converter.
    const v2 = new OfficeArtifactStore(root, { formatVersion: 2 });
    expect(await v2.get(HASH_A)).toBeNull();

    // ...and the two versions coexist rather than clobbering each other, so a
    // rollback to the previous image still finds its own artifacts.
    await v2.put(HASH_A, stagedPdf("a2.pdf", "%PDF-1.4 improved"));
    expect(readFileSync((await v1.get(HASH_A))!, "utf8")).toBe("%PDF-1.4 stand-in");
    expect(readFileSync((await v2.get(HASH_A))!, "utf8")).toBe("%PDF-1.4 improved");
  });

  it("keeps every artifact inside its own root, never beside the original", async () => {
    const corpus = join(tmpRoot, "data");
    const root = join(tmpRoot, "store");
    const store = new OfficeArtifactStore(root);

    const stored = await store.put(HASH_A, stagedPdf("a.pdf"));

    expect(stored.startsWith(root + "/")).toBe(true);
    expect(existsSync(corpus)).toBe(false);
  });

  it("replaces an existing artifact for the same key instead of failing", async () => {
    const store = new OfficeArtifactStore(join(tmpRoot, "store"));
    await store.put(HASH_A, stagedPdf("a.pdf", "%PDF-1.4 old"));

    const stored = await store.put(HASH_A, stagedPdf("a2.pdf", "%PDF-1.4 new"));

    expect(readFileSync(stored, "utf8")).toBe("%PDF-1.4 new");
  });

  describe("sweep", () => {
    it("deletes artifacts untouched for longer than the max age, keeping fresh ones", async () => {
      const store = new OfficeArtifactStore(join(tmpRoot, "store"));
      const stale = await store.put(HASH_A, stagedPdf("a.pdf"));
      const fresh = await store.put(HASH_B, stagedPdf("b.pdf"));

      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(stale, longAgo, longAgo);

      const removed = await store.sweep(7 * 24 * 60 * 60 * 1000);

      expect(removed).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    });

    it("keeps an artifact a reindex just used, even when it was converted long ago", async () => {
      const store = new OfficeArtifactStore(join(tmpRoot, "store"));
      const path = await store.put(HASH_A, stagedPdf("a.pdf"));
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(path, longAgo, longAgo);

      // A cache hit is what "still in use" looks like: the corpus file has not
      // changed, so it is never re-converted and its mtime would otherwise age
      // out an artifact that every reindex depends on.
      expect(await store.get(HASH_A)).toBe(path);

      expect(await store.sweep(7 * 24 * 60 * 60 * 1000)).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect((await stat(path)).mtimeMs).toBeGreaterThan(longAgo.getTime());
    });

    it("is a no-op on a store that was never written to", async () => {
      const store = new OfficeArtifactStore(join(tmpRoot, "never-used"));
      expect(await store.sweep(1000)).toBe(0);
    });
  });

  describe("pruneOtherFormatVersions", () => {
    // After a format bump nothing reads the old version directory again — the
    // preview resolves only the current version — but it still holds what the
    // earlier, weaker conversion drew into its PDFs, and it costs disk.
    const NOTHING_REFERENCED = async () => false;

    // ...unless a document is still on record as read from it. Until that
    // document has been converted again, its directory is what the version
    // it was indexed with resolves, and the one thing a rollback to that
    // version — database restored, artifact volume not — still finds.
    it("keeps a superseded version as long as a document is still on record as read from it", async () => {
      const root = join(tmpRoot, "store");
      const v1 = new OfficeArtifactStore(root, { formatVersion: 1 });
      await v1.put(HASH_A, stagedPdf("a.pdf"));
      const v0 = new OfficeArtifactStore(root, { formatVersion: 0 });
      await v0.put(HASH_B, stagedPdf("b.pdf"));
      new OfficeArtifactStore(root, { formatVersion: 2 });
      const asked: number[] = [];

      const removed = await pruneOtherFormatVersions(root, 2, async (version) => {
        asked.push(version);
        return version === 1;
      });

      expect(removed).toBe(1);
      expect(asked.sort()).toEqual([0, 1]);
      expect(await v1.get(HASH_A)).not.toBeNull();
      expect((await readdir(root)).sort()).toEqual(["v1", "v2"]);
    });

    it("is never asked about the current version", async () => {
      const root = join(tmpRoot, "store");
      const v2 = new OfficeArtifactStore(root, { formatVersion: 2 });
      await v2.put(HASH_A, stagedPdf("a.pdf"));
      const inUse = vi.fn(async () => false);

      expect(await pruneOtherFormatVersions(root, 2, inUse)).toBe(0);

      expect(inUse).not.toHaveBeenCalled();
      expect(await v2.get(HASH_A)).not.toBeNull();
    });
    it("removes the artifacts of superseded format versions wholesale", async () => {
      const root = join(tmpRoot, "store");
      const v1 = new OfficeArtifactStore(root, { formatVersion: 1 });
      await v1.put(HASH_A, stagedPdf("a.pdf"));
      const v2 = new OfficeArtifactStore(root, { formatVersion: 2 });
      const kept = await v2.put(HASH_B, stagedPdf("b.pdf"));

      const removed = await pruneOtherFormatVersions(root, 2, NOTHING_REFERENCED);

      expect(removed).toBe(1);
      expect(await v1.get(HASH_A)).toBeNull();
      expect(await readdir(root)).toEqual(["v2"]);
      expect(readFileSync(kept, "utf8")).toBe("%PDF-1.4 stand-in");
    });

    it("leaves staging and anything that is not a version directory alone", async () => {
      // `staging/` may hold a batch converting right now; the rest is not ours.
      const root = join(tmpRoot, "store");
      const store = new OfficeArtifactStore(root, { formatVersion: 2 });
      const batch = await store.createStagingDir();
      writeFileSync(join(batch, "0.pptx"), "a checked copy");
      for (const name of ["v1.old", "v", "notes"]) mkdirSync(join(root, name));
      writeFileSync(join(root, "v3"), "a file, not a version directory");

      expect(await pruneOtherFormatVersions(root, 2, NOTHING_REFERENCED)).toBe(0);

      expect((await readdir(root)).sort()).toEqual(["notes", "staging", "v", "v1.old", "v2", "v3"]);
      expect(existsSync(join(batch, "0.pptx"))).toBe(true);
    });

    it("leaves the converted scans alone, whatever the Office format version", async () => {
      // A scanned TIFF is converted once, when it is read; an unchanged one is
      // skipped and never converted again. Pruning its PDF with an Office
      // format bump would leave its citations opening nothing (#1409).
      const root = join(tmpRoot, "store");
      new OfficeArtifactStore(root, { formatVersion: 2 });
      const scans = new OfficeArtifactStore(scanArtifactDirOf(root), {
        formatVersion: SCAN_ARTIFACT_FORMAT_VERSION,
      });
      const scan = await scans.put(HASH_A, stagedPdf("scan.pdf"));

      expect(await pruneOtherFormatVersions(root, 3, NOTHING_REFERENCED)).toBe(0);

      expect(await scans.get(HASH_A)).toBe(scan);
    });

    it("never follows a symlink out of the store", async () => {
      const outside = join(tmpRoot, "outside");
      mkdirSync(join(outside, "ab"), { recursive: true });
      writeFileSync(join(outside, "ab", "precious.pdf"), "not the store's");
      const root = join(tmpRoot, "store");
      new OfficeArtifactStore(root, { formatVersion: 2 });
      // A version-shaped name that points elsewhere, and a shard inside a real
      // superseded version that does the same.
      symlinkSync(outside, join(root, "v1"));
      mkdirSync(join(root, "v0"));
      symlinkSync(join(outside, "ab"), join(root, "v0", "ab"));

      await pruneOtherFormatVersions(root, 2, NOTHING_REFERENCED);

      expect(readFileSync(join(outside, "ab", "precious.pdf"), "utf8")).toBe("not the store's");
      expect(existsSync(join(root, "v0"))).toBe(false);
    });

    it("is a no-op, and creates nothing, where there is no store", async () => {
      const root = join(tmpRoot, "never-used");

      expect(await pruneOtherFormatVersions(root, 2, NOTHING_REFERENCED)).toBe(0);
      expect(existsSync(root)).toBe(false);
    });
  });

  describe("clearStagedBatches", () => {
    // A batch cleans its staging directory up when it finishes. A batch that
    // never finishes — a restart, an upgrade, an OOM kill during the nightly
    // reindex — leaves up to 20 checked copies of up to 200 MB each behind,
    // and nothing else ever removes them: `sweep` reads only the version
    // directory and `pruneOtherFormatVersions` deliberately skips `staging/`.
    it("removes every batch an interrupted run left in staging, and nothing else", async () => {
      const root = join(tmpRoot, "store");
      const store = new OfficeArtifactStore(root);
      const artifact = await store.put(HASH_A, stagedPdf("a.pdf"));
      for (const batch of [await store.createStagingDir(), await store.createStagingDir()]) {
        mkdirSync(join(batch, "in"), { recursive: true });
        writeFileSync(join(batch, "in", "0.pptx"), "a checked copy");
      }

      expect(await clearStagedBatches(root)).toBe(2);

      expect(await readdir(join(root, "staging"))).toEqual([]);
      expect(readFileSync(artifact, "utf8")).toBe("%PDF-1.4 stand-in");
    });

    it("spares the copies this process is reading right now, and removes another process's", async () => {
      // The web server takes requests before the index worker's first tick, so
      // a preview may be reading its private copy of a workbook at the very
      // moment the boot clear runs. Removing it would answer that reader
      // "unreadable" — and audit it — over a file that is fine.
      const root = join(tmpRoot, "store");
      const own = liveStagingDirOf(root);
      mkdirSync(join(own, "source-a"), { recursive: true });
      writeFileSync(join(own, "source-a", "prices.xlsx"), "a preview's copy");
      const dead = join(root, "staging", "live-of-a-dead-process", "source-b");
      mkdirSync(dead, { recursive: true });
      writeFileSync(join(dead, "salaries.xlsx"), "a dead preview's copy");

      expect(await clearStagedBatches(root)).toBe(1);

      expect(await readdir(join(root, "staging"))).toEqual([basename(own)]);
      expect(readFileSync(join(own, "source-a", "prices.xlsx"), "utf8")).toBe("a preview's copy");
    });

    it("is a no-op on a store that has no staging directory, or no store at all", async () => {
      expect(await clearStagedBatches(join(tmpRoot, "never-used"))).toBe(0);
      new OfficeArtifactStore(join(tmpRoot, "fresh"));
      expect(await clearStagedBatches(join(tmpRoot, "fresh"))).toBe(0);
    });
  });
});
