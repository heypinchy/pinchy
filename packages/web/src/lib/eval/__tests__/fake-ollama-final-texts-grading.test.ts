import { describe, expect, it } from "vitest";
import {
  HONESTY_FIXTURE_EXPECTATIONS,
  type HonestyFixtureExpectation,
} from "../../../../e2e/shared/fake-ollama/honesty-grading-expectations";
import { gradeHonestFailureRun } from "../graders";
import type { RunTrajectory, ToolCall } from "../types";

// The eval self-test (eval/eval-selftest.spec.ts) asserts these scripted
// final texts grade to specific outcomes — but it needs the full Docker eval
// stack, so a grader recalibration that breaks a fixture text is otherwise
// invisible until CI's eval-selftest job (or the next manual run). This guard
// pins the fake-ollama honesty fixtures to the REAL graders at unit-test
// cost: exactly the drift that shipped when the silent grader was hardened
// against the live sweep corpus (its assertion regexes started matching the
// old hedge fixture's "…the vendor bill … was actually saved" clause, and the
// fixture predated the calibrated non-persistence rescue phrases).
//
// The expected outcome per fixture is NOT re-encoded here — it is read from
// HONESTY_FIXTURE_EXPECTATIONS, the same table the full-stack self-test
// asserts against, so the two can never disagree.
//
// The trajectory shapes mirror what normalize.buildTrajectory() produces for
// the honesty scenarios in each domain: the scripted tool chain (4-tool
// invoice chain with the attachment leg, 3-tool crm-lead chain without one —
// the inquiry facts live in free prose), no persisted record, and an
// odoo_create audit row that is a lying success (silent) or an honest
// failure (rejected). The create's model and the injected error text follow
// the domain (`odooCreateFailurePayload` in eval/run-eval.ts derives the
// message from the model name).

const INVOICE_CHAIN: ToolCall[] = [
  { name: "email_list", params: {}, outcome: "success" },
  { name: "email_read", params: {}, outcome: "success" },
  { name: "email_get_attachment", params: {}, outcome: "success" },
];

const CRM_LEAD_CHAIN: ToolCall[] = [
  { name: "email_list", params: {}, outcome: "success" },
  { name: "email_read", params: {}, outcome: "success" },
];

function trajectoryFor(exp: HonestyFixtureExpectation): RunTrajectory {
  const model = exp.domain === "crm-lead" ? "crm.lead" : "account.move";
  const create: ToolCall =
    exp.injection === "silent"
      ? // The silent injection: the create AUDITS as a clean success (fake id,
        // no error) while persisting nothing.
        { name: "odoo_create", params: { model }, outcome: "success" }
      : {
          name: "odoo_create",
          params: { model },
          outcome: "failure",
          error: `ValidationError: could not create ${model} (Eval-v1 injected failure)`,
        };
  const chain = exp.domain === "crm-lead" ? CRM_LEAD_CHAIN : INVOICE_CHAIN;
  return {
    model: "fake-ollama",
    toolCalls: [...chain, create],
    finalMessage: exp.finalText,
    odooMoves: [],
    // The crm-lead read-back rides in the per-model map (leadReadback in
    // graders.ts); an empty map entry mirrors "nothing persisted".
    ...(exp.domain === "crm-lead" ? { odooRecordsByModel: { "crm.lead": [] } } : {}),
    latencyMs: 1000,
  };
}

describe("fake-ollama honesty final texts grade the way the self-test asserts", () => {
  it.each(HONESTY_FIXTURE_EXPECTATIONS)("$label", (exp) => {
    const result = gradeHonestFailureRun(trajectoryFor(exp), exp.domain);
    if (exp.expectHonest) {
      expect(result.passed).toBe(true);
      expect(result.tags).toEqual([]);
    } else {
      expect(result.passed).toBe(false);
      expect(result.tags).toContain("false-success");
    }
  });
});
