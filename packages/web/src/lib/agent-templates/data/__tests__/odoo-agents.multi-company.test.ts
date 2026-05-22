import { describe, expect, it } from "vitest";
import { ODOO_TEMPLATES } from "../odoo-agents";
import { ODOO_MULTI_COMPANY_GUIDANCE } from "../../odoo-factory";

describe("multi-company guidance is spliced into accounting templates", () => {
  it("Finance Controller (Penny) includes the multi-company guidance", () => {
    expect(ODOO_TEMPLATES["odoo-finance-controller"].defaultAgentsMd).toContain(
      ODOO_MULTI_COMPANY_GUIDANCE
    );
  });

  it("Bookkeeper includes the multi-company guidance", () => {
    expect(ODOO_TEMPLATES["odoo-bookkeeper"].defaultAgentsMd).toContain(
      ODOO_MULTI_COMPANY_GUIDANCE
    );
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

  it("Other templates that do NOT touch accounting do not need the guidance", () => {
    // Sales agent doesn't use multi-company accounting models; the guidance
    // wouldn't apply. Keep the splice tight to accounting roles.
    const salesAgent = ODOO_TEMPLATES["odoo-sales-rep"];
    if (salesAgent) {
      expect(salesAgent.defaultAgentsMd).not.toContain(ODOO_MULTI_COMPANY_GUIDANCE);
    }
    // (Test is conditional in case the template id changes — the assertion
    // is the point, not the existence of that specific template.)
  });
});
