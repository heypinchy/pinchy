/**
 * `put()` across volumes.
 *
 * In the container a batch is staged in the office-converter's spool and
 * committed into `pinchy-kb-artifacts` — two volumes, so `rename()` fails with
 * EXDEV. A test machine has one filesystem and never sees that, so `rename` is
 * made to fail here the way the kernel makes it fail there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import * as fsp from "node:fs/promises";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-exdev-"));
});

afterEach(() => {
  vi.mocked(fsp.rename).mockClear();
  rmSync(root, { recursive: true, force: true });
});

function exdev(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("EXDEV: cross-device link not permitted");
  err.code = "EXDEV";
  return err;
}

describe("OfficeArtifactStore.put across volumes", () => {
  it("copies the staged PDF in when it cannot be renamed, and still commits atomically", async () => {
    const store = new OfficeArtifactStore(join(root, "store"));
    const staged = join(root, "spool-batch-0.pdf");
    await writeFile(staged, "%PDF converted");
    vi.mocked(fsp.rename).mockRejectedValueOnce(exdev());

    const path = await store.put("hash-a", staged);

    expect(await readFile(path, "utf8")).toBe("%PDF converted");
    expect(path).toBe(store.pathFor("hash-a"));
    // The copy went to a temporary name beside the artifact and was renamed
    // into place — a reader can never be handed a half-copied file — and no
    // temporary is left behind.
    expect(await readdir(dirname(path))).toEqual([path.split("/").pop()]);
    // The staged original is consumed, as a rename would have consumed it.
    await expect(readFile(staged)).rejects.toThrow();
  });

  it("does not swallow a rename failure that is not about crossing volumes", async () => {
    const store = new OfficeArtifactStore(join(root, "store"));
    const staged = join(root, "batch-0.pdf");
    await writeFile(staged, "%PDF");
    const denied: NodeJS.ErrnoException = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.mocked(fsp.rename).mockRejectedValueOnce(denied);

    await expect(store.put("hash-b", staged)).rejects.toThrow(/EACCES/);
  });
});
