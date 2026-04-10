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

  it("returns missingModels with technical name when model is not in connection", () => {
    const connectionModels: ModelAccessData[] = [
      {
        model: "sale.order",
        name: "Orders",
        access: { read: true, create: true, write: true, delete: false },
      },
    ];

    const result = validateOdooTemplate(templateConfig, connectionModels);

    // res.partner not in connection → falls back to technical name
    expect(result.missingModels).toEqual([{ model: "res.partner", name: "res.partner" }]);
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

  it("uses template model name as fallback when model is not in connection data", () => {
    const config: OdooTemplateConfig = {
      accessLevel: "read-only",
      requiredModels: [{ model: "stock.quant", operations: ["read"] }],
    };

    const result = validateOdooTemplate(config, []);

    // Model not in connection → no display name available, fall back to technical name
    expect(result.missingModels).toEqual([{ model: "stock.quant", name: "stock.quant" }]);
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
});
