import { describe, expect, it } from "vitest";
import { groupTemplates } from "../template-grouping";

describe("groupTemplates", () => {
  it("separates standard templates from Odoo templates", () => {
    const templates = [
      {
        id: "knowledge-base",
        name: "Knowledge Base",
        description: "Answer questions from your docs",
        requiresDirectories: true,
        requiresOdooConnection: false,
        defaultTagline: "Answer questions from your docs",
      },
      {
        id: "custom",
        name: "Custom Agent",
        description: "Start from scratch",
        requiresDirectories: false,
        requiresOdooConnection: false,
        defaultTagline: null,
      },
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only" as const,
        defaultTagline: "Analyze revenue",
      },
    ];

    const result = groupTemplates(templates);

    expect(result.standard).toEqual([
      expect.objectContaining({ id: "knowledge-base" }),
      expect.objectContaining({ id: "custom" }),
    ]);
    expect(result.odoo).toEqual([expect.objectContaining({ id: "odoo-sales-analyst" })]);
  });

  it("returns empty odoo group when no Odoo templates exist", () => {
    const templates = [
      {
        id: "knowledge-base",
        name: "Knowledge Base",
        description: "Answer questions from your docs",
        requiresDirectories: true,
        requiresOdooConnection: false,
        defaultTagline: "Answer questions from your docs",
      },
    ];

    const result = groupTemplates(templates);

    expect(result.standard).toHaveLength(1);
    expect(result.odoo).toEqual([]);
  });

  it("handles all Odoo templates", () => {
    const templates = [
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only" as const,
        defaultTagline: "Analyze revenue",
      },
      {
        id: "odoo-inventory-scout",
        name: "Inventory Scout",
        description: "Monitor stock",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only" as const,
        defaultTagline: "Monitor stock",
      },
    ];

    const result = groupTemplates(templates);

    expect(result.standard).toEqual([]);
    expect(result.odoo).toHaveLength(2);
  });

  it("treats templates without requiresOdooConnection as standard", () => {
    const templates = [
      {
        id: "custom",
        name: "Custom Agent",
        description: "Start from scratch",
        requiresDirectories: false,
        defaultTagline: null,
      },
    ];

    const result = groupTemplates(templates);

    expect(result.standard).toHaveLength(1);
    expect(result.odoo).toEqual([]);
  });
});
