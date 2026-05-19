import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

describe("odoo-bookkeeper template", () => {
  const template = AGENT_TEMPLATES["odoo-bookkeeper"];
  const md = template.defaultAgentsMd;

  it("documents that price_unit is tax-exclusive (net)", () => {
    expect(md).toMatch(/price_unit`[^.]{0,80}tax-exclusive/i);
  });

  it("mandates post-create verification against amount_total within tolerance", () => {
    expect(md).toMatch(/verify the draft|amount_total.*receipt/i);
    expect(md).toMatch(/0\.02 EUR/);
  });
});
