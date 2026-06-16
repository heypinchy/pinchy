import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { getOdooTools } from "@/lib/tool-registry";

/**
 * Every `odoo_*` tool named in an Odoo template's AGENTS.md must be a real,
 * registered tool. This catches phantom tool names — e.g. `odoo_search`, which
 * does not exist (the read tool is `odoo_read`) — that silently tell the agent
 * to call a tool it does not have, producing "tool not found" errors on
 * stricter models. Drift guard: a new template that references a misspelled or
 * not-yet-built tool fails here.
 */
describe("Odoo template tool references", () => {
  const validOdooTools = new Set(getOdooTools().map((t) => t.id));

  const odooTemplates = Object.values(AGENT_TEMPLATES).filter((t) => t.requiresOdooConnection);

  it("covers the Odoo templates", () => {
    expect(odooTemplates.length).toBeGreaterThan(0);
  });

  for (const template of odooTemplates) {
    it(`${template.name}: only references registered odoo_* tools`, () => {
      const referenced = [...new Set(template.defaultAgentsMd.match(/odoo_[a-z_]+/g) ?? [])];
      const invalid = referenced.filter((name) => !validOdooTools.has(name));
      expect(invalid).toEqual([]);
    });
  }
});
