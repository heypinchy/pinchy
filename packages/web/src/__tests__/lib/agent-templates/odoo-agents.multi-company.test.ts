import { describe, expect, it } from "vitest";
import { ODOO_TEMPLATES } from "@/lib/agent-templates/data/odoo-agents";
import { getSkillBody } from "@/lib/skills";

describe("multi-company guidance is carried by accounting templates", () => {
  it("only core-ledger templates (those that touch account.move.line) carry the odoo-multi-company skill", () => {
    // Data-driven drift guard: any template whose required models include
    // `account.move.line` (the journal-item table that participates in
    // cross-company write conflicts) SHOULD carry the odoo-multi-company skill;
    // everything else MUST NOT. Templates that only read auxiliary accounting
    // models such as `account.tax` (CRM, sales) or write to
    // `account.analytic.line` (timesheets) do not run into the multi-company
    // create/write traps the guidance warns about, so they intentionally skip
    // it.
    //
    // Since #546 the guidance lives in the shared `odoo-multi-company` SKILL.md
    // rather than being spliced into each template's defaultAgentsMd; the
    // template opts in through `defaultSkills`.
    //
    // HEURISTIC, NOT A DEFINITION: `account.move.line` is a proxy for "this
    // template walks the general ledger and can produce cross-company writes."
    // It happens to match Penny + Bookkeeper today. If a future template
    // covers cross-company accounting WITHOUT touching `account.move.line`
    // (e.g. a Tax Auditor that reads `account.move`, `account.account`, and
    // `account.journal` only), this predicate will *forbid* the skill —
    // wrongly. When that happens, widen the predicate (e.g. union of any
    // `account.*` write op + `account.move` read) rather than carve an
    // ad-hoc allow-list. The test's job is to prevent silent drift, not to
    // adjudicate which templates need accounting context.
    for (const [id, template] of Object.entries(ODOO_TEMPLATES)) {
      const touchesCoreLedger = (template.odooConfig?.requiredModels ?? []).some(
        (m) => m.model === "account.move.line"
      );
      const carriesSkill = (template.defaultSkills ?? []).includes("odoo-multi-company");
      if (touchesCoreLedger) {
        expect(
          carriesSkill,
          `Template '${id}' touches account.move.line but is missing the odoo-multi-company skill`
        ).toBe(true);
      } else {
        expect(
          carriesSkill,
          `Template '${id}' does not touch account.move.line but unexpectedly carries the odoo-multi-company skill`
        ).toBe(false);
      }
    }
  });

  const guidance = getSkillBody("odoo-multi-company");

  it("the odoo-multi-company skill describes the [Company X] label suffix", () => {
    expect(guidance).toMatch(/\[.*Company.*\]/i);
  });

  it("the odoo-multi-company skill mentions company_id filtering", () => {
    expect(guidance).toMatch(/company_id/);
  });

  it("the odoo-multi-company skill warns about cross-company write rejection", () => {
    expect(guidance).toMatch(/cross-company/i);
  });
});
