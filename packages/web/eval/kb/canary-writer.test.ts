import { readdir, rm, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { KB_EVAL_CANARY_JSONL_LINE, isCanaryLine } from "../canary";
import { RESULTS_DIR, appendRunResult, appendTrajectory, readExistingRuns } from "./run-kb-eval";
import type { KbRunResultRow } from "../../src/lib/eval/kb/types";
import type { KbRunTrajectory } from "../../src/lib/eval/kb/answer-graders";

/**
 * The write-side complement to `canary-coverage.test.ts`, and the sibling of
 * `../__tests__/canary-writer.test.ts` — which guards the Eval-v1 writer and
 * only that one.
 *
 * `run-kb-eval.ts`'s header says its JSONL plumbing is "identical in shape to
 * ../run-eval.ts's already-exercised equivalents" and therefore untested here.
 * That stopped being true when this harness grew its OWN `ensureCanaryHeader`:
 * a private copy that the Eval-v1 tests cannot reach, writing a different
 * constant. The coverage guard next door only ever sees files that already
 * reached `data/`, so a writer that stopped marking fresh files would be caught
 * at publication — one crawl too late for the sweep's own `results/`, which is
 * where the file is born and the only moment that reliably precedes every copy
 * of it. This is the one thing in this harness that cannot be retrofitted.
 */
const TEMP_PREFIX = "kb-canary-writer-test-";
function tempLabel(): string {
  return `${TEMP_PREFIX}${randomUUID()}`;
}

function run(scenario: string): KbRunResultRow {
  return {
    model: "ollama-cloud/test",
    scenario,
    axis: "happy",
    passed: true,
    tags: [],
    notes: [],
    latencyMs: 1,
  };
}

function trajectory(): KbRunTrajectory {
  return {
    model: "ollama-cloud/test",
    query: "How often are laptops replaced?",
    answer: "Every three years [1].",
    retrieved: [{ n: 1, sourcePath: "/data/it-equipment-policy.md", page: null }],
    citedPassageTexts: ["Laptops are replaced every three years."],
    latencyMs: 1,
  };
}

// The writer targets the real (gitignored) results/ dir, so sweep by prefix
// rather than by a tracked label list — this also clears a temp file an earlier
// run was killed before deleting.
afterEach(async () => {
  let entries: string[];
  try {
    entries = await readdir(RESULTS_DIR);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((f) => f.startsWith(TEMP_PREFIX))
      .map((f) => rm(path.join(RESULTS_DIR, f), { force: true }))
  );
});

describe("canary header on fresh KB result files", () => {
  it("appendRunResult writes the KB canary as the first line, then the run reads back", async () => {
    const label = tempLabel();

    await appendRunResult(label, run("gqa-happy-1"));

    const text = await readFile(path.join(RESULTS_DIR, `${label}.jsonl`), "utf8");
    // Byte-identical to the KB constant, not merely canary-SHAPED, and not the
    // Eval-v1 line: a sweep that stamped the wrong benchmark would still pass
    // `isCanaryLine`, and the name is the only thing telling a human which
    // dataset a scraped line belongs to.
    expect(text.split("\n")[0]).toBe(KB_EVAL_CANARY_JSONL_LINE);
    // The canary must not perturb resume accounting: exactly one run reads back.
    await expect(readExistingRuns(label)).resolves.toHaveLength(1);
  });

  it("appendRunResult writes the canary only once across appends", async () => {
    const label = tempLabel();

    await appendRunResult(label, run("gqa-happy-1"));
    await appendRunResult(label, run("gqa-happy-2"));

    const lines = (await readFile(path.join(RESULTS_DIR, `${label}.jsonl`), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines.filter(isCanaryLine)).toHaveLength(1);
    await expect(readExistingRuns(label)).resolves.toHaveLength(2);
  });

  it("appendTrajectory writes the canary as the first line of a fresh sidecar", async () => {
    const label = tempLabel();

    await appendTrajectory(label, "gqa-happy-1", trajectory(), true, []);

    const text = await readFile(path.join(RESULTS_DIR, `${label}.trajectories.jsonl`), "utf8");
    expect(text.split("\n")[0]).toBe(KB_EVAL_CANARY_JSONL_LINE);
  });
});
