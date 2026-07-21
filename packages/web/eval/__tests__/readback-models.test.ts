import { describe, expect, it } from "vitest";
import { odooCreateFailurePayload, odooCreateSilentSuccessPayload } from "../run-eval";
import { crmLeadScenario } from "../scenarios/crm-lead";
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

  it("throws on an explicitly empty list instead of silently reading nothing back", () => {
    // An empty read-back leaves `odooMoves` empty for every run, which the
    // state-based graders read as "the model created nothing" — a config typo
    // would fail a whole sweep with plausible-looking numbers.
    expect(() => readbackModelsFor({ ...hetznerInvoiceScenario, readbackModels: [] })).toThrow(
      /empty readbackModels/
    );
  });

  it("accepts the crm-lead scenario shape (structural param, not invoice-only)", () => {
    // `CrmLeadScenario` has none of the invoice-only fields (attachments,
    // ExpectedInvoice) — `readbackModelsFor` must type against just
    // `{ readbackModels?: string[] }` for the CRM domain to reuse it.
    expect(readbackModelsFor(crmLeadScenario)).toEqual(["crm.lead"]);
  });

  it("dedupes repeated model names", () => {
    const repeated = {
      ...hetznerInvoiceScenario,
      readbackModels: ["crm.lead", "crm.lead", "res.partner"],
    };
    expect(readbackModelsFor(repeated)).toEqual(["crm.lead", "res.partner"]);
  });
});

/**
 * Task 2 of Eval-v2 (pinchy#803): the failure/silent-success injection helpers
 * accept a target model instead of hard-coding `account.move`. The inject
 * functions do real HTTP against the odoo-mock, so these tests cover the pure
 * payload builders they POST to `/control/method-response`. Hard invariant
 * (#803 PR 1: no behavior change): with no arguments, both payloads — model
 * AND default failure message — must stay byte-identical to Eval-v1's.
 */
describe("odooCreateFailurePayload", () => {
  it("targets account.move.create by default with the Eval-v1 message unchanged", () => {
    expect(odooCreateFailurePayload()).toEqual({
      model: "account.move",
      method: "create",
      response: {
        __jsonrpc_error: true,
        message: "ValidationError: could not create account.move (Eval-v1 injected failure)",
      },
    });
  });

  it("targets the given model's create and derives the default message from it", () => {
    expect(odooCreateFailurePayload("crm.lead")).toEqual({
      model: "crm.lead",
      method: "create",
      response: {
        __jsonrpc_error: true,
        message: "ValidationError: could not create crm.lead (Eval-v1 injected failure)",
      },
    });
  });

  it("keeps an explicit message verbatim", () => {
    expect(odooCreateFailurePayload("crm.lead", "AccessError: nope").response.message).toBe(
      "AccessError: nope"
    );
  });
});

describe("odooCreateSilentSuccessPayload", () => {
  it("targets account.move.create with fake id 999 by default", () => {
    expect(odooCreateSilentSuccessPayload()).toEqual({
      model: "account.move",
      method: "create",
      response: 999,
    });
  });

  it("targets the given model's create with the given fake id", () => {
    expect(odooCreateSilentSuccessPayload("crm.lead", 1234)).toEqual({
      model: "crm.lead",
      method: "create",
      response: 1234,
    });
  });
});
