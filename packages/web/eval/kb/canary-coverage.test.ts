import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_CANARY_GUID, KB_EVAL_CANARY_JSONL_LINE, isCanaryLine } from "../canary";

/**
 * Contamination-canary coverage for the KB harness — the sibling of
 * `../__tests__/canary-coverage.test.ts`, which guards the Eval-v1 tree and
 * only that tree.
 *
 * That scoping is the whole reason this file exists. #869 published the repo's
 * SECOND public benchmark dataset (`eval/kb/data/`) and the existing guard
 * could not see it, so an unmarked gold set and 48 unmarked runs would have
 * shipped while every check stayed green — a gate reporting on what it looks
 * at rather than on what it should, the same shape as the format gate that
 * only ever read `packages/web`.
 *
 * The stakes are higher here than for a normal drift guard: the canary is
 * IMPOSSIBLE TO RETROFIT. Once a file is crawled unmarked, no later commit can
 * mark the copy in the training corpus. And the KB set is the more
 * memorizable of the two — `gold-qa.ts` carries the questions AND reference
 * answers, and the published trajectories carry the corpus passages verbatim.
 */
const KB_DIR = path.join(__dirname);
const CORPUS_DIR = path.join(KB_DIR, "corpus");
const DATA_DIR = path.join(KB_DIR, "data");

/**
 * The query/answer keys only — NOT `corpus/docs/`. The corpus documents are
 * indexed text: a canary comment inside one would change its chunks, its
 * embeddings and therefore the retrieval scores the fixture in
 * `corpus/embeddings.json` pins. The test SET is what leaks a benchmark;
 * the corpus is ordinary prose about a fictional company.
 */
const GOLD_SOURCES = ["gold-qa.ts", "gold-queries.ts"];

const dataFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith(".jsonl"));

describe("canary coverage over the KB gold set", () => {
  it.each(GOLD_SOURCES)("%s carries the canary GUID", (file) => {
    const text = readFileSync(path.join(CORPUS_DIR, file), "utf8");
    expect(text).toContain(EVAL_CANARY_GUID);
  });

  it("names every gold-set source that exists", () => {
    // A hand-written list that mirrors a directory goes stale silently, and a
    // gold source added later is exactly the file that must not ship unmarked.
    const onDisk = readdirSync(CORPUS_DIR).filter(
      (f) => f.startsWith("gold-") && f.endsWith(".ts")
    );
    expect(onDisk.sort()).toEqual([...GOLD_SOURCES].sort());
  });
});

describe("canary coverage over published KB data files", () => {
  it("has data files to guard", () => {
    // Without this the suite below is `it.each([])` — zero assertions, green.
    // The corpus floor is the difference between a guard and decoration.
    expect(dataFiles.length).toBeGreaterThan(0);
  });

  it.each(dataFiles)("%s begins with the canary header line", (file) => {
    const text = readFileSync(path.join(DATA_DIR, file), "utf8");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(isCanaryLine(firstLine)).toBe(true);
    // Byte-identical, for the same reason as the Eval-v1 sibling: a published
    // marker is unamendable, so the repo and the wild must not drift apart.
    expect(firstLine).toBe(KB_EVAL_CANARY_JSONL_LINE);
  });
});
