import { describe, it, expect } from "vitest";
import { ODOO_AGENT_WORKBENCH_HINT } from "@/lib/agent-templates/odoo-factory";

// Shared snippet for read-write Odoo operator templates that have
// pinchy_write enabled. Mirrors ODOO_ATTACHMENT_REF_FLOW: keep one
// canonical instruction so every operator stays in sync. See #418.
describe("ODOO_AGENT_WORKBENCH_HINT", () => {
  it("names workbench/ as the canonical write target", () => {
    expect(ODOO_AGENT_WORKBENCH_HINT).toMatch(/workbench\//);
  });

  it("references the pinchy_write tool", () => {
    expect(ODOO_AGENT_WORKBENCH_HINT).toMatch(/pinchy_write/);
  });

  it("distinguishes workbench/ (agent-written) from uploads/ (user-uploaded)", () => {
    expect(ODOO_AGENT_WORKBENCH_HINT).toMatch(/uploads\//);
  });

  it("forbids writing to the workspace root", () => {
    expect(ODOO_AGENT_WORKBENCH_HINT).toMatch(/root|system files/i);
  });
});
