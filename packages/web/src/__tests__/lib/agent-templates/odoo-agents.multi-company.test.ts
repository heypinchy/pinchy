import { describe, expect, it } from "vitest";
import { ODOO_TEMPLATES } from "@/lib/agent-templates/data/odoo-agents";
import { ODOO_MULTI_COMPANY_GUIDANCE } from "@/lib/agent-templates/odoo-factory";

describe("multi-company guidance is spliced into accounting templates", () => {
  it("only core-ledger templates (those that touch account.move.line) include the guidance", () => {
    // Data-driven drift guard: any template whose required models include
    // `account.move.line` (the journal-item table that participates in
    // cross-company write conflicts) SHOULD carry the guidance; everything
    // else MUST NOT. Templates that only read auxiliary accounting models
    // such as `account.tax` (CRM, sales) or write to `account.analytic.line`
    // (timesheets) do not run into the multi-company create/write traps the
    // guidance warns about, so they intentionally skip it.
    //
    // Keeps the splice tight to real bookkeeping roles and auto-extends as
    // new core-ledger templates land.
    for (const [id, template] of Object.entries(ODOO_TEMPLATES)) {
      const touchesCoreLedger = (template.odooConfig?.requiredModels ?? []).some(
        (m) => m.model === "account.move.line"
      );
      const includesGuidance = template.defaultAgentsMd?.includes(ODOO_MULTI_COMPANY_GUIDANCE);
      if (touchesCoreLedger) {
        expect(
          includesGuidance,
          `Template '${id}' touches account.move.line but is missing ODOO_MULTI_COMPANY_GUIDANCE`
        ).toBe(true);
      } else {
        expect(
          includesGuidance,
          `Template '${id}' does not touch account.move.line but unexpectedly includes ODOO_MULTI_COMPANY_GUIDANCE`
        ).toBe(false);
      }
    }
  });

  it("ODOO_MULTI_COMPANY_GUIDANCE describes the [Company X] label suffix", () => {
    expect(ODOO_MULTI_COMPANY_GUIDANCE).toMatch(/\[.*Company.*\]/i);
  });

  it("ODOO_MULTI_COMPANY_GUIDANCE mentions company_id filtering", () => {
    expect(ODOO_MULTI_COMPANY_GUIDANCE).toMatch(/company_id/);
  });

  it("ODOO_MULTI_COMPANY_GUIDANCE warns about cross-company write rejection", () => {
    expect(ODOO_MULTI_COMPANY_GUIDANCE).toMatch(/cross-company/i);
  });
});
