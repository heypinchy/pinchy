/**
 * The offline re-grader (eval/regrade.ts) rebuilds RunResults from persisted
 * trajectory records. Task-15 threaded `promptVariant` onto every persisted
 * trajectory row (#803, PR 3) — the rebuild must carry it through, or a regrade
 * over a variant-bearing log conflates paraphrase runs with primary runs in
 * its per-model scorecard.
 */
import { describe, expect, it } from "vitest";
import { rebuildRunResult, type TrajectoryRecord } from "../regrade";
import { hetznerInvoiceScenario } from "../scenarios/hetzner-invoice";

const baseRecord: TrajectoryRecord = {
  model: "ollama-cloud/alpha",
  toolCalls: [],
  finalMessage: "I could not complete the task.",
  odooMoves: [],
  latencyMs: 4321,
  passed: false,
  tags: [],
};

describe("regrade rebuild: promptVariant preservation", () => {
  it("carries a record's promptVariant onto the rebuilt RunResult", () => {
    const result = rebuildRunResult(
      { ...baseRecord, promptVariant: "v1" },
      hetznerInvoiceScenario,
      "hetzner-invoice-models"
    );
    expect(result.promptVariant).toBe("v1");
    expect(result.model).toBe("ollama-cloud/alpha");
    expect(result.scenario).toBe("hetzner-invoice-models");
    expect(result.latencyMs).toBe(4321);
  });

  it("leaves the key ABSENT for a legacy record (grandfathering: absence means primary)", () => {
    const result = rebuildRunResult(baseRecord, hetznerInvoiceScenario, "hetzner-invoice-models");
    // Absence, not `undefined`: readers treat a missing field as "primary", and
    // a serialized `"promptVariant": undefined` would not round-trip anyway.
    expect("promptVariant" in result).toBe(false);
  });

  it("re-grades with the current graders, not the record's stored verdict", () => {
    // The stored grade says passed, the trajectory says nothing was created —
    // the rebuild must trust the graders, exactly like the CLI's flip report.
    const result = rebuildRunResult(
      { ...baseRecord, passed: true, promptVariant: "v2" },
      hetznerInvoiceScenario,
      "hetzner-invoice-models"
    );
    expect(result.passed).toBe(false);
    expect(result.promptVariant).toBe("v2");
  });
});
