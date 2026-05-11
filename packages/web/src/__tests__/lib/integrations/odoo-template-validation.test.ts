import { describe, it, expect } from "vitest";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";
import type { OdooTemplateConfig } from "@/lib/agent-templates";

describe("validateOdooTemplate", () => {
  it("flags a required model as missing when absent from the connection", () => {
    const template: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [{ model: "account.move", operations: ["read", "write"] }],
    };
    const result = validateOdooTemplate(template, []);
    expect(result.valid).toBe(false);
    expect(result.missingModels.map((m) => m.model)).toContain("account.move");
  });

  it("returns valid when every required model is present", () => {
    const template: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [{ model: "account.move", operations: ["read", "write"] }],
    };
    const result = validateOdooTemplate(template, [
      {
        model: "account.move",
        name: "Journal Entry",
        access: { read: true, create: false, write: true, delete: false },
      },
    ]);
    expect(result.valid).toBe(true);
    expect(result.missingModels).toEqual([]);
  });

  it("does NOT block creation when an optional model is missing (Odoo Community case)", () => {
    // The Approval Manager template needs `approval.request` on Odoo
    // Enterprise but the model does not exist in Community. Marking it
    // optional must keep the template creatable: `missingModels` (which
    // disables the Create button in new-agent-form.tsx) should not include
    // optional misses. The agent's AGENTS.md tells the model to discover
    // model availability via `odoo_schema` at runtime.
    const template: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [
        { model: "hr.expense.sheet", operations: ["read", "write"] },
        { model: "approval.request", operations: ["read", "write"], optional: true },
      ],
    };
    const result = validateOdooTemplate(template, [
      {
        model: "hr.expense.sheet",
        name: "Expense Sheet",
        access: { read: true, create: false, write: true, delete: false },
      },
    ]);
    expect(result.valid).toBe(true);
    expect(result.missingModels).toEqual([]);
  });

  it("surfaces missing optional models in warnings (so the UI can mention them)", () => {
    const template: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [{ model: "approval.request", operations: ["read"], optional: true }],
    };
    const result = validateOdooTemplate(template, []);
    expect(result.warnings.some((w) => w.includes("approval.request"))).toBe(true);
  });

  it("still blocks creation when a non-optional model is missing even if optional ones also miss", () => {
    const template: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [
        { model: "hr.expense.sheet", operations: ["read", "write"] }, // required
        { model: "approval.request", operations: ["read"], optional: true },
      ],
    };
    const result = validateOdooTemplate(template, []);
    expect(result.valid).toBe(false);
    expect(result.missingModels.map((m) => m.model)).toEqual(["hr.expense.sheet"]);
  });
});
