import { readdirSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEvalJsonl } from "../canary";
import { buildScorecard } from "../../src/lib/eval/scorecard";
import type { PromptVariantId, RunResult, RunTrajectory } from "../../src/lib/eval/types";
import {
  RESULTS_DIR,
  appendTrajectory,
  resolvePromptForVariant,
  type PersistedTrajectory,
} from "../run-eval";
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
  it("covers every scenario module in eval/scenarios/", () => {
    // Bound to the DIRECTORY, not a hardcoded count (Task-14 review): a 12th
    // scenario file must fail here until it joins the variant contract above,
    // instead of silently skipping it. Names must match file basenames exactly,
    // which also rules out duplicates covering for a missing scenario.
    const scenarioFiles = readdirSync(path.join(__dirname, "..", "scenarios"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""));
    expect(scenarios.map((s) => s.name).sort()).toEqual(scenarioFiles.sort());
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

/**
 * Variant-aware runs (#803, PR 3): `runOnce` resolves the dispatched prompt
 * from `scenario.prompts` via `resolvePromptForVariant` and stamps
 * `promptVariant` onto every RunResult row and trajectory row it writes. Rows
 * written by sweeps BEFORE this change lack the field entirely — the read
 * contract is absence ≡ "primary" (grandfathering; headline filtering on the
 * field is Task 16, only the data model + writer live here).
 */
describe("promptVariant threading", () => {
  describe("resolvePromptForVariant", () => {
    it("resolves primary and each variant id to its exact text", () => {
      const prompts = hetznerInvoiceScenario.prompts;
      expect(resolvePromptForVariant(prompts, "primary")).toBe(prompts.primary);
      expect(resolvePromptForVariant(prompts, "v1")).toBe(prompts.variants[0].text);
      expect(resolvePromptForVariant(prompts, "v2")).toBe(prompts.variants[1].text);
    });

    it("throws on an unknown variant id instead of silently falling back", () => {
      // The compile-time union already forbids this, but a variant id will
      // eventually arrive from an env var (Task 18) — an unknown id must never
      // quietly dispatch the primary and mislabel the rows.
      expect(() =>
        resolvePromptForVariant(hetznerInvoiceScenario.prompts, "v3" as PromptVariantId)
      ).toThrow(/v3/);
    });
  });

  describe("persisted rows", () => {
    it("round-trips promptVariant through a RunResult JSONL row", () => {
      const row: RunResult = {
        model: "ollama-cloud/test",
        scenario: "hetzner-invoice-models",
        promptVariant: "v1",
        passed: true,
        tags: [],
        notes: [],
        latencyMs: 1,
      };
      const [parsed] = parseEvalJsonl<RunResult>(`${JSON.stringify(row)}\n`);
      expect(parsed.promptVariant).toBe("v1");
    });

    it("treats a grandfathered row without the field as primary", () => {
      // A verbatim pre-#803 row: no promptVariant key at all.
      const legacy = `{"model":"ollama-cloud/test","passed":true,"tags":[],"notes":[],"latencyMs":1}`;
      const [parsed] = parseEvalJsonl<RunResult>(legacy);
      expect(parsed.promptVariant).toBeUndefined();
      expect(parsed.promptVariant ?? "primary").toBe("primary");
    });

    it("aggregates variant rows exactly like grandfathered rows", () => {
      // The aggregation behind the scorecard/triage-guard chain groups by model
      // and reads passed/tags only — it is shape-agnostic, so a promptVariant
      // field must ride along without being dropped, double-counted, or treated
      // as an anomaly. (Splitting the headline BY variant is Task 16, not this.)
      const base = { model: "ollama-cloud/test", tags: [], notes: [], latencyMs: 1 };
      const runs: RunResult[] = [
        { ...base, passed: true }, // grandfathered pre-#803 row
        { ...base, passed: true, promptVariant: "primary" },
        { ...base, passed: false, promptVariant: "v2" },
      ];
      const [cell, ...rest] = buildScorecard(runs);
      expect(rest).toEqual([]);
      expect(cell).toMatchObject({ model: "ollama-cloud/test", n: 3, passes: 2 });
    });
  });

  describe("trajectory writer", () => {
    const TEMP_PREFIX = "prompt-variants-test-";

    // The writer targets the real (gitignored) results/ dir; sweep by prefix so
    // aborted runs never leave temp files behind (same pattern as
    // canary-writer.test.ts).
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

    it("stamps promptVariant onto every trajectory row, defaulting to primary", async () => {
      const label = `${TEMP_PREFIX}${randomUUID()}`;
      const traj: RunTrajectory = {
        model: "ollama-cloud/test",
        toolCalls: [],
        finalMessage: "done",
        odooMoves: [],
        latencyMs: 1,
      };

      await appendTrajectory(label, traj, true, [], "v2");
      await appendTrajectory(label, traj, true, []); // no variant given → primary

      const text = await readFile(path.join(RESULTS_DIR, `${label}.trajectories.jsonl`), "utf8");
      const rows = parseEvalJsonl<PersistedTrajectory>(text);
      expect(rows.map((r) => r.promptVariant)).toEqual(["v2", "primary"]);
    });
  });
});
