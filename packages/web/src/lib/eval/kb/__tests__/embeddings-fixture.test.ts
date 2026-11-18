import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEmbeddings } from "../../../../../eval/kb/embeddings-fixture";

// These guard loadEmbeddings()'s two friendly-error branches (ENOENT and
// JSON-parse failure). The earlier "fixture is missing" test asserted the real
// on-disk absence of embeddings.json and would have flipped red the moment the
// fixture was committed; these drive the SAME branches via loadEmbeddings()'s
// injectable path arg, pointing it at a genuinely-missing path and a
// deliberately-corrupt temp file — real fs, no mocks, and independent of the
// committed fixture's presence. (vi.mock("node:fs") does not reach the loader's
// transitively-imported binding here, so real paths are both simpler and more
// faithful.)
describe("loadEmbeddings() friendly-error branches", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("throws an actionable 'run pnpm kb-eval:reembed' error when the fixture file is missing (ENOENT)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-eval-fixture-"));
    const missingPath = join(tmpDir, "does-not-exist.json");

    // Substring match on the actionable regeneration command, not the full
    // message, so wording tweaks don't over-couple the test to the copy.
    expect(() => loadEmbeddings(missingPath)).toThrow(/kb-eval:reembed/);
  });

  it("throws a clear parse error naming kb-eval:reembed when the fixture is not valid JSON", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-eval-fixture-"));
    const corruptPath = join(tmpDir, "corrupt.json");
    writeFileSync(corruptPath, "{ not json", "utf8");

    expect(() => loadEmbeddings(corruptPath)).toThrow(/not valid JSON/);
    // Same fixture-regeneration guidance is surfaced for the corrupt-file case.
    expect(() => loadEmbeddings(corruptPath)).toThrow(/kb-eval:reembed/);
  });
});
