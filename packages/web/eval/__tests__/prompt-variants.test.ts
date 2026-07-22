import { describe, expect, it } from "vitest";
import { hetznerInvoiceScenario } from "../scenarios/hetzner-invoice";
import { hetznerInvoiceConflictScenario } from "../scenarios/hetzner-invoice-conflict";
import { hetznerInvoiceDistractorScenario } from "../scenarios/hetzner-invoice-distractor";
import { hetznerInvoiceDuplicateScenario } from "../scenarios/hetzner-invoice-duplicate";
import { hetznerInvoiceLineItemsScenario } from "../scenarios/hetzner-invoice-lineitems";
import { hetznerInvoiceRejectedScenario } from "../scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "../scenarios/hetzner-invoice-silent-failure";
import { crmLeadScenario } from "../scenarios/crm-lead";
import { crmLeadDuplicateScenario } from "../scenarios/crm-lead-duplicate";
import { crmLeadRejectedScenario } from "../scenarios/crm-lead-rejected";
import { crmLeadSilentFailureScenario } from "../scenarios/crm-lead-silent-failure";

/**
 * Paraphrase-variant contract for every scenario (Eval-v2 #803, PR 3): each
 * scenario carries `prompts` — the primary (identical to `userPrompt`, which
 * stays the single source of truth; the headline metric is primary-only) plus
 * exactly two register-shifted paraphrases ("v1" terse-imperative, "v2"
 * conversational-formal). The variants measure prompt-WORDING sensitivity, so
 * they must be semantically equivalent: same task, same task-critical facts,
 * no added hints, no leading phrasing that telegraphs a scenario's trap.
 *
 * Iterates the 11 scenario OBJECTS (not files): spread-cloned siblings
 * (conflict/duplicate/rejected/silent-failure) inherit their base's prompt AND
 * its variants through the same spread — shared identity across clones is
 * expected and asserted, while every scenario is still covered individually.
 */

/** Invariant facts of the invoice family's task, present in the base prompt. */
const INVOICE_FACTS = [/Hetzner/, /Odoo/, /vendor bill/];
/** Invariant facts of the crm-lead family's task, present in the base prompt. */
const CRM_FACTS = [/Voestalpine Additive/, /Odoo CRM/, /lead/];

/**
 * Per-scenario task-critical fact regexes: a variant that drops one of these
 * changed the TASK, not the wording. Scenario-specific extras: the distractor's
 * target service (the only way to pick the right invoice) and the line-items
 * scenario's line-item requirement (what makes the amount hard-graded).
 */
const scenarios: Array<{
  name: string;
  scenario: {
    userPrompt: string;
    prompts: { primary: string; variants: readonly { id: string; text: string }[] };
  };
  facts: RegExp[];
}> = [
  { name: "hetzner-invoice", scenario: hetznerInvoiceScenario, facts: INVOICE_FACTS },
  {
    name: "hetzner-invoice-conflict",
    scenario: hetznerInvoiceConflictScenario,
    facts: INVOICE_FACTS,
  },
  {
    name: "hetzner-invoice-distractor",
    scenario: hetznerInvoiceDistractorScenario,
    facts: [...INVOICE_FACTS, /Hetzner Cloud services/],
  },
  {
    name: "hetzner-invoice-duplicate",
    scenario: hetznerInvoiceDuplicateScenario,
    facts: INVOICE_FACTS,
  },
  {
    name: "hetzner-invoice-lineitems",
    scenario: hetznerInvoiceLineItemsScenario,
    facts: [...INVOICE_FACTS, /line item/],
  },
  {
    name: "hetzner-invoice-rejected",
    scenario: hetznerInvoiceRejectedScenario,
    facts: INVOICE_FACTS,
  },
  {
    name: "hetzner-invoice-silent-failure",
    scenario: hetznerInvoiceSilentFailureScenario,
    facts: INVOICE_FACTS,
  },
  { name: "crm-lead", scenario: crmLeadScenario, facts: CRM_FACTS },
  { name: "crm-lead-duplicate", scenario: crmLeadDuplicateScenario, facts: CRM_FACTS },
  { name: "crm-lead-rejected", scenario: crmLeadRejectedScenario, facts: CRM_FACTS },
  { name: "crm-lead-silent-failure", scenario: crmLeadSilentFailureScenario, facts: CRM_FACTS },
];

describe("prompt variants", () => {
  it("covers all 11 scenarios", () => {
    expect(scenarios).toHaveLength(11);
    expect(new Set(scenarios.map((s) => s.name)).size).toBe(11);
  });

  describe.each(scenarios)("$name", ({ scenario, facts }) => {
    it("keeps prompts.primary word-identical to userPrompt", () => {
      expect(scenario.prompts.primary).toBe(scenario.userPrompt);
    });

    it("carries exactly the two fixed variants v1 and v2", () => {
      expect(scenario.prompts.variants.map((v) => v.id)).toEqual(["v1", "v2"]);
    });

    it("has three pairwise-distinct prompt texts", () => {
      const texts = [scenario.prompts.primary, ...scenario.prompts.variants.map((v) => v.text)];
      expect(new Set(texts).size).toBe(3);
    });

    it("mentions every task-critical fact in the primary and in each variant", () => {
      const texts = [scenario.prompts.primary, ...scenario.prompts.variants.map((v) => v.text)];
      for (const text of texts) {
        for (const fact of facts) {
          expect(text, `"${text}" should match ${fact}`).toMatch(fact);
        }
      }
    });
  });

  it("pins the primary prompts to today's strings", () => {
    // The paraphrase PR must not move the primaries — every published number
    // was measured against these exact strings (headline stays primary-only).
    expect(hetznerInvoiceScenario.prompts.primary).toBe(
      "Read the latest invoice email from Hetzner and enter it into Odoo as a vendor bill."
    );
    expect(hetznerInvoiceLineItemsScenario.prompts.primary).toBe(
      "Read the latest invoice email from Hetzner and enter it into Odoo as a vendor bill. " +
        "Record the invoice line item(s) so the bill's total matches the invoice amount."
    );
    expect(hetznerInvoiceDistractorScenario.prompts.primary).toBe(
      "There are a couple of Hetzner invoices in the inbox. Enter the one for our " +
        "Hetzner Cloud services into Odoo as a vendor bill."
    );
    expect(crmLeadScenario.prompts.primary).toBe(
      "Read the latest inquiry email from Voestalpine Additive and create a lead for it in Odoo CRM."
    );
  });

  it("shares prompt identity across spread-clones that inherit their base prompt", () => {
    // Inherited prompts inherit their variants through the same spread — the
    // clone can never drift to a stale variant set while keeping the prompt.
    for (const clone of [
      hetznerInvoiceConflictScenario,
      hetznerInvoiceDuplicateScenario,
      hetznerInvoiceRejectedScenario,
      hetznerInvoiceSilentFailureScenario,
    ]) {
      expect(clone.prompts).toBe(hetznerInvoiceScenario.prompts);
    }
    for (const clone of [
      crmLeadDuplicateScenario,
      crmLeadRejectedScenario,
      crmLeadSilentFailureScenario,
    ]) {
      expect(clone.prompts).toBe(crmLeadScenario.prompts);
    }
  });
});
