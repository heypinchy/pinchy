import { describe, expect, it } from "vitest";
import { hetznerInvoiceScenario, readbackModelsFor } from "../scenarios/hetzner-invoice";

/**
 * Task 1 of Eval-v2 (pinchy#803): the orchestrator's post-run Odoo read-back
 * is parametrized per scenario via `readbackModels` instead of a hard-coded
 * `getOdooRecords("account.move")`. The field is OPTIONAL with a defaulting
 * helper because the sibling scenarios (`hetzner-invoice-rejected.ts` et al.)
 * spread-clone the base scenario — they must keep grading identically without
 * declaring the field.
 */
describe("readbackModelsFor", () => {
  it("defaults to account.move when the scenario declares no readbackModels", () => {
    // The base scenario deliberately leaves the field unset — the invoice
    // family's read-back behavior must not change (#803 PR 1: no behavior
    // change).
    expect(hetznerInvoiceScenario.readbackModels).toBeUndefined();
    expect(readbackModelsFor(hetznerInvoiceScenario)).toEqual(["account.move"]);
  });

  it("defaults for spread-cloned scenarios that never mention the field", () => {
    const cloned = { ...hetznerInvoiceScenario };
    expect(readbackModelsFor(cloned)).toEqual(["account.move"]);
  });

  it("returns the declared list when a scenario opts in", () => {
    const crmScenario = {
      ...hetznerInvoiceScenario,
      readbackModels: ["crm.lead", "res.partner"],
    };
    expect(readbackModelsFor(crmScenario)).toEqual(["crm.lead", "res.partner"]);
  });
});
