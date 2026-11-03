/**
 * OfficeArtifactStore: the on-disk home of converted Office PDFs.
 *
 * The two properties worth a test are the ones a wrong answer makes invisible:
 * a bumped format_version must invalidate EVERYTHING (otherwise improving the
 * converter silently keeps serving the old output forever), and nothing may
 * ever be written next to the original (`/data` is mounted read-only and the
 * docs state that as a product promise).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { readdir, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearStagedBatches,
  liveStagingDirOf,
  OfficeArtifactStore,
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

    it("removes the artifacts of superseded format versions wholesale", async () => {
      const root = join(tmpRoot, "store");
      const v1 = new OfficeArtifactStore(root, { formatVersion: 1 });
      await v1.put(HASH_A, stagedPdf("a.pdf"));

      const v2 = new OfficeArtifactStore(root, { formatVersion: 2 });
      const removed = await v2.pruneOtherFormatVersions();

      expect(removed).toBe(1);
      expect(await v1.get(HASH_A)).toBeNull();
      expect(await readdir(root)).toEqual(["v2"]);
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
