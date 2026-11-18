import { describe, expect, it } from "vitest";
import { validateOdooTemplate } from "../odoo-template-validation";
import type { OdooTemplateConfig } from "@/lib/agent-templates";

interface ModelAccessData {
  model: string;
  name: string;
  access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
}

describe("validateOdooTemplate", () => {
  const templateConfig: OdooTemplateConfig = {
    accessLevel: "read-write",
    requiredModels: [
      { model: "sale.order", operations: ["read", "create", "write"] },
      { model: "res.partner", operations: ["read", "write"] },
    ],
  };

  it("returns valid with no warnings when all models and operations are available", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: true, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: true, write: true, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.availableModels).toEqual([
      { model: "sale.order", operations: ["read", "create", "write"] },
      { model: "res.partner", operations: ["read", "write"] },
    ]);
  });

  it("returns warnings for models missing write access when template requires it", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: false, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: true, write: true, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(["sale.order: write not available"]);
    expect(result.availableModels).toEqual([
      { model: "sale.order", operations: ["read", "create"] },
      { model: "res.partner", operations: ["read", "write"] },
    ]);
  });

  it("returns invalid when any required model is missing", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: true, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.valid).toBe(false);
    expect(result.warnings).toEqual(["res.partner: model not available"]);
    expect(result.availableModels).toEqual([
      { model: "sale.order", operations: ["read", "create", "write"] },
    ]);
  });

  it("returns missingModels as plain model names when a model is not in the connection", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: true, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.missingModels).toEqual(["res.partner"]);
  });

  it("returns empty missingModels when all models are available", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: true, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: true, write: true, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.missingModels).toEqual([]);
  });

  it("names a model the connection has never been probed for", () => {
    const config: OdooTemplateConfig = {
      accessLevel: "read-only",
      requiredModels: [{ model: "stock.quant", operations: ["read"] }],
    };

    const result = validateOdooTemplate(config, []);

    expect(result.missingModels).toEqual(["stock.quant"]);
  });

  it("returns invalid when no required models are accessible", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "account.move",
        name: "Journal Entries",
        access: { read: true, create: false, write: false, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.valid).toBe(false);
    expect(result.warnings).toEqual([
      "sale.order: model not available",
      "res.partner: model not available",
    ]);
    expect(result.availableModels).toEqual([]);
  });

  it("handles models without access field (backward compat - assume full access)", () => {
    const connectionModels: ModelAccessData[] = [
      { model: "sale.order", name: "Orders" },
      { model: "res.partner", name: "Contacts" },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.availableModels).toEqual([
      { model: "sale.order", operations: ["read", "create", "write"] },
      { model: "res.partner", operations: ["read", "write"] },
    ]);
  });

  it("availableModels only includes actually available operations", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: false, write: false, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: false, write: false, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      "sale.order: create not available",
      "sale.order: write not available",
      "res.partner: write not available",
    ]);
    expect(result.availableModels).toEqual([
      { model: "sale.order", operations: ["read"] },
      { model: "res.partner", operations: ["read"] },
    ]);
  });

  it("does NOT block creation when an optional model is missing (Odoo Community case)", () => {
    // The Approval Manager template needs `approval.request` on Odoo
    // Enterprise but the model does not exist in Community. Marking it
    // optional must keep the template creatable: `missingModels` (which
    // disables the Create button in new-agent-form.tsx) should not include
    // optional misses. The agent's AGENTS.md tells the model to discover
    // model availability via `odoo_schema` at runtime.
    const config: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [
        { model: "hr.expense.sheet", operations: ["read", "write"] },
        { model: "approval.request", operations: ["read", "write"], optional: true },
      ],
    };
    const result = validateOdooTemplate(config, [
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
    const config: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [{ model: "approval.request", operations: ["read"], optional: true }],
    };
    const result = validateOdooTemplate(config, []);
    expect(result.warnings.some((w) => w.includes("approval.request"))).toBe(true);
  });

  it("still blocks creation when a non-optional model is missing even if optional ones also miss", () => {
    const config: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [
        { model: "hr.expense.sheet", operations: ["read", "write"] },
        { model: "approval.request", operations: ["read"], optional: true },
      ],
    };
    const result = validateOdooTemplate(config, []);
    expect(result.valid).toBe(false);
    expect(result.missingModels).toEqual(["hr.expense.sheet"]);
  });

  // ── Denied operations (#1208 follow-up) ─────────────────────────────────
  //
  // `missingModels` only ever names a model the connection has never heard
  // of. A model that IS in the catalogue but whose required operations the
  // Odoo API user may not perform produces the SAME user-visible failure —
  // "Permission denied: write on account.bank.statement.line" at first use —
  // and used to leave `valid: true` with nothing but a free-text warning. So
  // the ungrantable operations are reported as their own actionable set.

  it("reports required operations the connection denies on a model it does have", () => {
    const result = validateOdooTemplate(templateConfig, [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: false, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: true, write: true, delete: false },
      },
    ]);

    expect(result.deniedOperations).toEqual([{ model: "sale.order", operations: ["write"] }]);
  });

  it("reports every denied operation on a model the connection grants nothing on", () => {
    const result = validateOdooTemplate(templateConfig, [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: false, create: false, write: false, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: true, write: true, delete: false },
      },
    ]);

    // Nothing grantable at all: the model is in neither availableModels nor
    // missingModels, which is exactly how it used to disappear.
    expect(result.availableModels).toEqual([
      { model: "res.partner", operations: ["read", "write"] },
    ]);
    expect(result.missingModels).toEqual([]);
    expect(result.deniedOperations).toEqual([
      { model: "sale.order", operations: ["read", "create", "write"] },
    ]);
  });

  it("leaves deniedOperations empty when every required operation is granted", () => {
    const result = validateOdooTemplate(templateConfig, [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: true, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: true, write: true, delete: false },
      },
    ]);

    expect(result.deniedOperations).toEqual([]);
  });

  // An OPTIONAL model is edition- or module-conditional, so a denial on it is
  // an ordinary fact rather than a hole — the same boundary `missingModels`
  // already draws. Reporting it would train an admin to ignore the signal.
  it("does not report denied operations on an optional model", () => {
    const config: OdooTemplateConfig = {
      accessLevel: "read-write",
      requiredModels: [
        { model: "approval.request", operations: ["read", "write"], optional: true },
      ],
    };

    const result = validateOdooTemplate(config, [
      {
        model: "approval.request",
        name: "Approvals",
        access: { read: true, create: false, write: false, delete: false },
      },
    ]);

    expect(result.deniedOperations).toEqual([]);
    expect(result.warnings).toEqual(["approval.request: write not available"]);
  });

  // `valid` gates template availability in /api/templates and the Create
  // button in new-agent-form.tsx. A denial is reported, not a block: the
  // template is still creatable and the gap rides on the audit trail.
  it("keeps valid true when only operations are denied", () => {
    const result = validateOdooTemplate(templateConfig, [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: false, delete: false },
      },
      {
        model: "res.partner",
        name: "Contacts",
        access: { read: true, create: true, write: true, delete: false },
      },
    ]);

    expect(result.valid).toBe(true);
  });
});
