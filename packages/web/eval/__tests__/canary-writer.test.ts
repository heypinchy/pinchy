import { rm, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCanaryLine } from "../canary";
import { RESULTS_DIR, appendRunResult, appendTrajectory, readExistingRuns } from "../run-eval";
import type { RunResult, RunTrajectory } from "../../src/lib/eval/types";

/**
 * A fresh scenario's very first persisted run must carry the canary, so a new
 * sweep's `results/` (and the `data/` it is published to) is never born
 * unmarked — the retrofit-impossible gap #794 closes for future data, the
 * write-side complement to the read-side coverage guard over today's files.
 */
const labels: string[] = [];
function tempLabel(): string {
  const label = `canary-writer-test-${randomUUID()}`;
  labels.push(label);
  return label;
}

afterEach(async () => {
  await Promise.all(
    labels
      .splice(0)
      .flatMap((l) => [
        rm(path.join(RESULTS_DIR, `${l}.jsonl`), { force: true }),
        rm(path.join(RESULTS_DIR, `${l}.trajectories.jsonl`), { force: true }),
      ])
  );
});

describe("canary header on fresh eval result files", () => {
  it("appendRunResult writes the canary as the first line, then the run reads back", async () => {
    const label = tempLabel();
    const run: RunResult = {
      model: "ollama-cloud/test",
      passed: true,
      tags: [],
      notes: [],
      latencyMs: 1,
      scenario: label,
    };

    await appendRunResult(label, run);

    const text = await readFile(path.join(RESULTS_DIR, `${label}.jsonl`), "utf8");
    expect(isCanaryLine(text.split("\n")[0])).toBe(true);
    // The canary must not perturb resume accounting: exactly one run reads back.
    await expect(readExistingRuns(label)).resolves.toHaveLength(1);
  });

  it("appendRunResult writes the canary only once across appends", async () => {
    const label = tempLabel();
    const run: RunResult = {
      model: "ollama-cloud/test",
      passed: false,
      tags: [],
      notes: [],
      latencyMs: 2,
      scenario: label,
    };

    await appendRunResult(label, run);
    await appendRunResult(label, run);

    const text = await readFile(path.join(RESULTS_DIR, `${label}.jsonl`), "utf8");
    const canaryLines = text.split("\n").filter((l) => isCanaryLine(l));
    expect(canaryLines).toHaveLength(1);
    await expect(readExistingRuns(label)).resolves.toHaveLength(2);
  });

  it("appendTrajectory writes the canary as the first line of a fresh file", async () => {
    const label = tempLabel();
    const traj: RunTrajectory = {
      model: "ollama-cloud/test",
      toolCalls: [],
      finalMessage: "done",
      odooMoves: [],
      latencyMs: 3,
    };

    await appendTrajectory(label, traj, true, []);

    const text = await readFile(path.join(RESULTS_DIR, `${label}.trajectories.jsonl`), "utf8");
    expect(isCanaryLine(text.split("\n")[0])).toBe(true);
  });
});
