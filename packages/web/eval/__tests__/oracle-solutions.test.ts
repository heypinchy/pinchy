import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertsRecordCreated, gradeRunForScenario } from "../../src/lib/eval/graders";
import { SCENARIOS } from "../export-scorecard";
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

/**
 * An honest-failure oracle must carry its honesty in the WORDING — it must not
 * read as a creation claim at all.
 *
 * Without this, a golden message can pass for the wrong reason:
 * `gradeFalseSuccessClaim` rescues a message that asserts creation but also
 * says one of the CREATION_FAILURE_PHRASES ("validation error", "injected
 * failure", …). Those literals describe the failure INJECTION's own error text,
 * so an oracle leaning on them proves the grader accepts the mock's wording,
 * not that it reads a competent agent's honesty. The first draft of the
 * hard-rejection oracle did exactly that — it asserted creation and survived
 * only on "validation error" — which masked a real grader hole: a negative
 * determiner/subject ("No record was created", "Nothing was recorded") was read
 * as a fabrication. See NEGATIVE_DETERMINER_ON_RECORD in graders.ts.
 */
describe("honest-failure oracles state their honesty without a rescue phrase", () => {
  const honestFailureOracles = ORACLES.filter(
    (o) => o.scenario.expectedOutcome === "honest-failure"
  );

  it("covers all four honest-failure scenarios", () => {
    // invoice rejected + silent-failure, crm-lead rejected + silent-failure.
    expect(honestFailureOracles).toHaveLength(4);
  });

  it.each(honestFailureOracles.map((o) => [o.label, o] as const))(
    "%s: the golden message does not read as a creation claim",
    (_label, oracle) => {
      // Checked under the ORACLE'S OWN domain: a lead-domain claim ("lead
      // angelegt", "created the lead") is invisible to the invoice patterns,
      // so the invoice default would vacuously pass every crm-lead oracle.
      expect(assertsRecordCreated(oracle.trajectory.finalMessage, oracle.scenario.domain)).toBe(
        false
      );
    }
  );
});

/**
 * Scenario modules whose oracle is still PENDING — each entry must name the
 * task that deletes it, and the list must stay empty in a finished release.
 * Currently empty (Task 10 authored the four crm-lead oracles); the mechanism
 * stays because it guards the scenario-before-oracle ordering of any FUTURE
 * scenario task, exactly as it did for Tasks 6-10.
 */
const PENDING_ORACLE_SCENARIOS: string[] = [];

/**
 * Oracle labels whose scenario is not yet registered in export-scorecard's
 * SCENARIOS — each entry must name the task that deletes it, and the list must
 * stay empty in a finished release. The crm-lead sweep labels land with the
 * sweep/export integration in Task 12 (#803): registering them earlier would
 * publish empty cells and break the dataset fingerprint, so until then the
 * label-consistency guard below unions this list with the published ones.
 */
const PENDING_EXPORT_LABELS = [
  "crm-lead-models",
  "crm-lead-duplicate-models",
  "crm-lead-rejected-models",
  "crm-lead-silent-failure-models",
];

describe("oracle coverage", () => {
  const coveredScenarioFiles = () =>
    readdirSync(SCENARIO_DIR).filter(
      (f) => f.endsWith(".ts") && !PENDING_ORACLE_SCENARIOS.includes(f)
    );

  it("has one oracle per scenario module", () => {
    expect(ORACLES).toHaveLength(coveredScenarioFiles().length);
  });

  // Counting alone would accept two oracles pointing at the SAME scenario while
  // another goes uncovered — 7 oracles, 7 unique labels, 6 scenarios graded.
  // Identity is what the guard actually promises.
  it("covers each scenario exactly once", () => {
    expect(new Set(ORACLES.map((o) => o.scenario)).size).toBe(coveredScenarioFiles().length);
  });

  it("only exempts scenario files that actually exist", () => {
    // A stale PENDING entry (e.g. Task 7 renames the file but not the list)
    // would silently widen the exemption forever.
    const allFiles = readdirSync(SCENARIO_DIR);
    for (const pending of PENDING_ORACLE_SCENARIOS) {
      expect(allFiles).toContain(pending);
    }
  });

  it("has a unique label per oracle", () => {
    const labels = ORACLES.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // The labels are the sweep's own, not a third hand-maintained copy: a rename
  // in export-scorecard's SCENARIOS must fail here rather than leave an oracle
  // pointing at a label nobody publishes. Labels awaiting export registration
  // (see PENDING_EXPORT_LABELS) are unioned in, so the guard stays exact:
  // Task 12 moves them into SCENARIOS and empties the pending list.
  it("uses exactly the published scenario labels plus the pending export labels", () => {
    expect(ORACLES.map((o) => o.label).sort()).toEqual(
      [...SCENARIOS.map((s) => s.label), ...PENDING_EXPORT_LABELS].sort()
    );
  });
});
