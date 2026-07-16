import { describe, it, expect } from "vitest";
import {
  findCatastrophicCells,
  CAPABILITY_SCENARIO_SLUGS,
  CAPABILITY_FLOOR,
  MIN_RUNS,
  type OutlierScenario,
} from "../outliers";

/** A scorecard cell, defaulting to a clean pass so tests state only what they mean. */
function cell(model: string, passes: number, n = 12, tags: Record<string, number> = {}) {
  return { model, n, passes, passRate: n > 0 ? passes / n : 0, tagHistogram: tags };
}

/**
 * Builds a scenario list from `{slug: [cells]}`. Every capability scenario is
 * present by default so a test that cares about one cell doesn't have to
 * restate the capability anchor.
 */
function scenarios(spec: Record<string, ReturnType<typeof cell>[]>): OutlierScenario[] {
  return Object.entries(spec).map(([slug, models]) => ({ slug, models }));
}

/** A model that is demonstrably able to drive the loop: high in every capability scenario. */
function capableEverywhere(model: string) {
  return Object.fromEntries(CAPABILITY_SCENARIO_SLUGS.map((slug) => [slug, [cell(model, 11)]]));
}

describe("findCatastrophicCells", () => {
  it("flags a clean zero from a model that is capable in the other scenarios", () => {
    const flagged = findCatastrophicCells(
      scenarios({
        ...capableEverywhere("minimax-m3"),
        "line-items": [cell("minimax-m3", 0, 12, { "wrong-field-extraction": 9 })],
      })
    );

    expect(flagged).toEqual([
      expect.objectContaining({
        scenario: "line-items",
        model: "minimax-m3",
        n: 12,
        tags: { "wrong-field-extraction": 9 },
      }),
    ]);
  });

  // The dataset's weak models (gpt-oss:20b, mistral-large-3, deepseek-v3.2)
  // score zero all over — and pass some failure scenarios by INCAPACITY, never
  // getting far enough to lie or duplicate (eval/data/README.md). Their zeros
  // carry no information, and flagging them would drown the signal that does.
  it("does not flag a zero from a model that is weak across the capability scenarios", () => {
    const flagged = findCatastrophicCells(
      scenarios({
        "happy-path": [cell("gpt-oss:20b", 0)],
        "distractor-inbox": [cell("gpt-oss:20b", 0)],
        "conflicting-data": [cell("gpt-oss:20b", 0)],
        "line-items": [cell("gpt-oss:20b", 0)],
      })
    );

    expect(flagged).toEqual([]);
  });

  // A capable model's zero in one scenario is the outlier this guard exists
  // for, so its own catastrophic cell must not be what disqualifies it from
  // the capability anchor.
  it("judges capability from the OTHER capability scenarios, not the flagged cell", () => {
    const flagged = findCatastrophicCells(
      scenarios({
        "happy-path": [cell("minimax-m3", 11)],
        "distractor-inbox": [cell("minimax-m3", 10)],
        "conflicting-data": [cell("minimax-m3", 5)],
        "line-items": [cell("minimax-m3", 0)],
      })
    );

    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ scenario: "line-items", model: "minimax-m3" });
  });

  // Zero means "never once" — a qualitatively different claim from "rarely".
  // A rate threshold would sweep in half the silent-failure column (glm-4.7
  // 1/12, gemma4 1/12) and turn the guard into noise nobody reads, which is
  // the failure mode it exists to fix.
  it("does not flag a cell that passed at least once", () => {
    const flagged = findCatastrophicCells(
      scenarios({
        ...capableEverywhere("kimi-k2.6"),
        "silent-failure": [cell("kimi-k2.6", 1, 12, { "false-success": 11 })],
      })
    );

    expect(flagged).toEqual([]);
  });

  it(`does not flag a zero measured over fewer than ${MIN_RUNS} runs`, () => {
    const flagged = findCatastrophicCells(
      scenarios({
        ...capableEverywhere("kimi-k2.6"),
        "silent-failure": [cell("kimi-k2.6", 0, MIN_RUNS - 1)],
      })
    );

    expect(flagged).toEqual([]);
  });

  // The guard's contract is "no clean zero from a capable model goes
  // unexplained" — not "tools are broken". duplicate-guard and silent-failure
  // measure judgement and honesty; their zeros need a verdict too, and the
  // ledger is where that verdict says which kind of defect it is.
  it("flags zeros in the judgement and honesty scenarios, not just the capability ones", () => {
    const flagged = findCatastrophicCells(
      scenarios({
        ...capableEverywhere("gemma4:31b"),
        "duplicate-guard": [cell("gemma4:31b", 0, 12, { "duplicate-created": 12 })],
        "silent-failure": [cell("gemma4:31b", 0, 11, { "false-success": 11 })],
      })
    );

    expect(flagged.map((f) => f.scenario)).toEqual(["duplicate-guard", "silent-failure"]);
  });

  it("reports the capability median it judged the model by", () => {
    const flagged = findCatastrophicCells(
      scenarios({
        "happy-path": [cell("minimax-m3", 12)],
        "distractor-inbox": [cell("minimax-m3", 6)],
        "conflicting-data": [cell("minimax-m3", 6)],
        "line-items": [cell("minimax-m3", 0)],
      })
    );

    // Median of the three OTHER capability scenarios: [0.5, 0.5, 1.0].
    expect(flagged[0]?.capabilityMedian).toBeCloseTo(0.5);
  });

  it("does not flag a model sitting exactly on the capability floor's wrong side", () => {
    const belowFloor = Math.round(12 * (CAPABILITY_FLOOR - 0.1));
    const flagged = findCatastrophicCells(
      scenarios({
        "happy-path": [cell("weak", belowFloor)],
        "distractor-inbox": [cell("weak", belowFloor)],
        "conflicting-data": [cell("weak", belowFloor)],
        "line-items": [cell("weak", 0)],
      })
    );

    expect(flagged).toEqual([]);
  });

  // A model with no capability-scenario coverage has nothing to anchor on;
  // treating "unknown" as "capable" would flag every zero from a model the
  // sweep never measured properly.
  it("does not flag a model with no capability-scenario coverage", () => {
    const flagged = findCatastrophicCells(
      scenarios({ "silent-failure": [cell("never-swept", 0, 12)] })
    );

    expect(flagged).toEqual([]);
  });
});
