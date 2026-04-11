import { describe, expect, it } from "vitest";
import { groupTemplates } from "../template-grouping";

describe("groupTemplates", () => {
  it("separates documents, odoo, and custom into three groups", () => {
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
        id: "contract-analyzer",
        name: "Contract Analyzer",
        description: "Review and analyze contracts",
        requiresDirectories: true,
        requiresOdooConnection: false,
        defaultTagline: "Review and analyze contracts",
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

    expect(result.documents).toEqual([
      expect.objectContaining({ id: "knowledge-base" }),
      expect.objectContaining({ id: "contract-analyzer" }),
    ]);
    expect(result.odoo).toEqual([expect.objectContaining({ id: "odoo-sales-analyst" })]);
    expect(result.custom).toEqual(expect.objectContaining({ id: "custom" }));
  });

  it("custom is null when no custom template exists", () => {
    const templates = [
      {
        id: "knowledge-base",
        name: "Knowledge Base",
        description: "Answer questions from your docs",
        requiresDirectories: true,
        defaultTagline: "Answer questions from your docs",
      },
    ];

    const result = groupTemplates(templates);

    expect(result.documents).toHaveLength(1);
    expect(result.custom).toBeNull();
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

    expect(result.documents).toHaveLength(1);
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

    expect(result.documents).toEqual([]);
    expect(result.odoo).toHaveLength(2);
  });

  it("sorts available templates before unavailable ones within odoo group", () => {
    const templates = [
      {
        id: "odoo-unavailable",
        name: "Unavailable Agent",
        description: "Missing modules",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only" as const,
        defaultTagline: "N/A",
        available: false,
      },
      {
        id: "odoo-available",
        name: "Available Agent",
        description: "All modules present",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only" as const,
        defaultTagline: "OK",
        available: true,
      },
    ];

    const result = groupTemplates(templates);

    expect(result.odoo[0].id).toBe("odoo-available");
    expect(result.odoo[1].id).toBe("odoo-unavailable");
  });

  it("puts document templates (requiresDirectories) into documents group, not custom", () => {
    const templates = [
      {
        id: "resume-screener",
        name: "Resume Screener",
        description: "Screen candidates",
        requiresDirectories: true,
        requiresOdooConnection: false,
        defaultTagline: "Screen candidates",
      },
    ];

    const result = groupTemplates(templates);

    expect(result.documents).toHaveLength(1);
    expect(result.custom).toBeNull();
  });
});
