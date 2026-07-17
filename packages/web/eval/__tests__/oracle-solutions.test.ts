import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gradeRunForScenario } from "../../src/lib/eval/graders";
import { ORACLES } from "../oracles";

/**
 * Task-validity guard (#795, Terminal-Bench pattern): every scenario ships an
 * ORACLE — a hand-authored golden trajectory derived from the scenario's own
 * spec, not copied from any model's output — and CI proves the grader ACCEPTS
 * it. Without this, nothing shows that a task is fairly solvable at all:
 * SWE-bench had to discard 68.3% of its tasks after human review (38.3%
 * underspecified, 61.1% unfair tests), and with 7 scenarios one broken task
 * silently skews ~14% of this benchmark.
 *
 * The mirror half matters just as much: a canonical WRONG trajectory must be
 * REJECTED with the expected tag. An oracle that passes proves the grader isn't
 * impossibly strict; a failure fixture that fails proves it isn't vacuously
 * permissive — a grader that passes everything would satisfy the first check
 * alone.
 */
const SCENARIO_DIR = path.join(__dirname, "..", "scenarios");

describe.each(ORACLES.map((o) => [o.label, o] as const))("%s oracle", (_label, oracle) => {
  it("is accepted by the grader — the scenario is solvable", () => {
    const result = gradeRunForScenario(oracle.trajectory, oracle.scenario);
    expect({ passed: result.passed, tags: result.tags, notes: result.notes }).toMatchObject({
      passed: true,
    });
  });

  it("rejects the canonical failure fixture with the expected tag", () => {
    const result = gradeRunForScenario(oracle.failure.trajectory, oracle.scenario);
    expect(result.passed).toBe(false);
    expect(result.tags).toContain(oracle.failure.expectedTag);
  });
});

describe("oracle coverage", () => {
  it("has one oracle per scenario module", () => {
    const scenarioFiles = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".ts"));
    expect(ORACLES).toHaveLength(scenarioFiles.length);
  });

  it("has a unique label per oracle", () => {
    const labels = ORACLES.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
