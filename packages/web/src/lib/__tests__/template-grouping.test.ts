import { describe, expect, it } from "vitest";
import {
  groupTemplatesByCategory,
  getAccessBadgeProps,
  getPermissionPreviewItems,
  type TemplateItem,
} from "../template-grouping";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

describe("getAccessBadgeProps", () => {
  it("returns green 'Documents · Read-only' for a documents template", () => {
    const result = getAccessBadgeProps({
      id: "knowledge-base",
      name: "Knowledge Base",
      description: "Answer questions",
      requiresDirectories: true,
      defaultTagline: null,
    });
    expect(result).toEqual({ label: "Documents · Read-only", variant: "green" });
  });

  it("returns green 'Odoo · Read-only' for Odoo read-only template", () => {
    const result = getAccessBadgeProps({
      id: "odoo-sales-analyst",
      name: "Sales Analyst",
      description: "Analyze revenue",
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "read-only",
      defaultTagline: null,
    });
    expect(result).toEqual({ label: "Odoo · Read-only", variant: "green" });
  });

  it("returns amber 'Odoo · Read & Write' for Odoo read-write template", () => {
    const result = getAccessBadgeProps({
      id: "odoo-crm-assistant",
      name: "CRM Assistant",
      description: "Manage leads",
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "read-write",
      defaultTagline: null,
    });
    expect(result).toEqual({ label: "Odoo · Read & Write", variant: "amber" });
  });

  it("returns red 'Odoo · Full Access' for Odoo full-access template", () => {
    const result = getAccessBadgeProps({
      id: "odoo-full",
      name: "Full Agent",
      description: "Full access",
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "full",
      defaultTagline: null,
    });
    expect(result).toEqual({ label: "Odoo · Full Access", variant: "red" });
  });

  it("returns null for custom template", () => {
    const result = getAccessBadgeProps({
      id: "custom",
      name: "Custom Agent",
      description: "Start from scratch",
      requiresDirectories: false,
      defaultTagline: null,
    });
    expect(result).toBeNull();
  });

  it("returns green 'Gmail · Read & Draft' for email template", () => {
    const result = getAccessBadgeProps({
      id: "email-assistant",
      name: "Email Assistant",
      description: "Read and draft emails",
      requiresDirectories: false,
      requiresEmailConnection: true,
      defaultTagline: null,
    });
    expect(result).toEqual({ label: "Gmail · Read & Draft", variant: "green" });
  });
});

describe("getPermissionPreviewItems", () => {
  it("returns read-only capabilities for Odoo read-only template", () => {
    const result = getPermissionPreviewItems({
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "read-only",
    });
    expect(result).toEqual([
      { icon: "check", text: "Read data from Odoo" },
      { icon: "cross", text: "Cannot create, modify, or delete records" },
    ]);
  });

  it("returns read-write capabilities for Odoo read-write template", () => {
    const result = getPermissionPreviewItems({
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "read-write",
    });
    expect(result).toEqual([
      { icon: "check", text: "Read and write data in Odoo" },
      { icon: "warning", text: "This agent can modify data in Odoo" },
    ]);
  });

  it("returns full-access capabilities for Odoo full template", () => {
    const result = getPermissionPreviewItems({
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "full",
    });
    expect(result).toEqual([
      { icon: "check", text: "Full access to Odoo data" },
      { icon: "warning", text: "This agent has full access including record deletion" },
    ]);
  });

  it("returns documents capabilities for documents template", () => {
    const result = getPermissionPreviewItems({
      requiresDirectories: true,
      requiresOdooConnection: false,
    });
    expect(result).toEqual([
      { icon: "check", text: "Read files in the selected directories" },
      { icon: "cross", text: "Cannot modify or delete files" },
    ]);
  });

  it("returns empty array for custom template", () => {
    const result = getPermissionPreviewItems({
      requiresDirectories: false,
    });
    expect(result).toEqual([]);
  });

  it("returns email capabilities for email template", () => {
    const result = getPermissionPreviewItems({
      requiresDirectories: false,
      requiresEmailConnection: true,
    });
    expect(result).toEqual([
      { icon: "check", text: "Read emails from connected Gmail account" },
      { icon: "check", text: "Create draft emails" },
      { icon: "cross", text: "Cannot send emails directly" },
    ]);
  });
});

describe("groupTemplatesByCategory", () => {
  const salesTemplate = {
    id: "odoo-sales-analyst",
    name: "Sales Analyst",
    description: "Analyze revenue",
    requiresDirectories: false,
    requiresOdooConnection: true,
    odooAccessLevel: "read-only" as const,
    defaultTagline: "Analyze revenue",
    available: true,
  };

  const crmTemplate = {
    id: "odoo-crm-assistant",
    name: "CRM Assistant",
    description: "Manage leads",
    requiresDirectories: false,
    requiresOdooConnection: true,
    odooAccessLevel: "read-write" as const,
    defaultTagline: "Manage leads",
    available: true,
  };

  const knowledgeBase = {
    id: "knowledge-base",
    name: "Knowledge Base",
    description: "Answer questions",
    requiresDirectories: true,
    defaultTagline: "Answer questions",
    available: true,
  };

  const resumeScreener = {
    id: "resume-screener",
    name: "Resume Screener",
    description: "Screen candidates",
    requiresDirectories: true,
    defaultTagline: "Screen candidates",
    available: true,
  };

  const onboardingGuide = {
    id: "onboarding-guide",
    name: "Onboarding Guide",
    description: "Guide new members",
    requiresDirectories: true,
    defaultTagline: "Guide new members",
    available: true,
  };

  const hrAnalyst = {
    id: "odoo-hr-analyst",
    name: "HR Analyst",
    description: "Track headcount",
    requiresDirectories: false,
    requiresOdooConnection: true,
    odooAccessLevel: "read-only" as const,
    defaultTagline: "Track headcount",
    available: true,
  };

  const customTemplate = {
    id: "custom",
    name: "Custom Agent",
    description: "Start from scratch",
    requiresDirectories: false,
    defaultTagline: null,
    available: true,
  };

  it("assigns odoo-sales-analyst to Sales & Customers", () => {
    const result = groupTemplatesByCategory([salesTemplate]);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].label).toBe("Sales & Customers");
    expect(result.categories[0].templates[0].id).toBe("odoo-sales-analyst");
  });

  it("assigns knowledge-base to Knowledge & Compliance", () => {
    const result = groupTemplatesByCategory([knowledgeBase]);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].label).toBe("Knowledge & Compliance");
  });

  it("assigns resume-screener to HR & Recruiting", () => {
    const result = groupTemplatesByCategory([resumeScreener]);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].label).toBe("HR & Recruiting");
  });

  it("mixes Document and Odoo templates in HR & Recruiting", () => {
    const result = groupTemplatesByCategory([onboardingGuide, hrAnalyst, resumeScreener]);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].label).toBe("HR & Recruiting");
    expect(result.categories[0].templates).toHaveLength(3);
  });

  it("extracts custom template separately, not in any category", () => {
    const result = groupTemplatesByCategory([knowledgeBase, customTemplate]);
    expect(result.custom).toEqual(expect.objectContaining({ id: "custom" }));
    const allCategoryTemplateIds = result.categories.flatMap((c) => c.templates.map((t) => t.id));
    expect(allCategoryTemplateIds).not.toContain("custom");
  });

  it("sorts available templates before unavailable within each category", () => {
    const unavailableSales = { ...salesTemplate, available: false };
    const result = groupTemplatesByCategory([unavailableSales, crmTemplate]);
    expect(result.categories[0].templates[0].id).toBe("odoo-crm-assistant");
    expect(result.categories[0].templates[1].id).toBe("odoo-sales-analyst");
  });

  it("returns categories in stable order: Sales, Finance, HR, Operations, Marketing, Knowledge", () => {
    // Provide templates from different categories in reverse order
    const result = groupTemplatesByCategory([knowledgeBase, resumeScreener, salesTemplate]);
    const labels = result.categories.map((c) => c.label);
    expect(labels).toEqual(["Sales & Customers", "HR & Recruiting", "Knowledge & Compliance"]);
  });

  it("omits categories with no matching templates in the input", () => {
    const result = groupTemplatesByCategory([knowledgeBase]);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].label).toBe("Knowledge & Compliance");
  });

  it("gracefully ignores unknown template IDs", () => {
    const unknown = {
      id: "unknown-template",
      name: "Unknown",
      description: "Mystery",
      requiresDirectories: false,
      defaultTagline: null,
      available: true,
    };
    const result = groupTemplatesByCategory([unknown, knowledgeBase]);
    expect(result.categories).toHaveLength(1);
    const allIds = result.categories.flatMap((c) => c.templates.map((t) => t.id));
    expect(allIds).not.toContain("unknown-template");
  });

  it("returns null custom when no custom template exists", () => {
    const result = groupTemplatesByCategory([salesTemplate]);
    expect(result.custom).toBeNull();
  });

  it("every registered template (except 'custom') maps to a category", () => {
    // Regression guard: a template that doesn't have an entry in
    // TEMPLATE_CATEGORY_MAP is silently dropped by groupTemplatesByCategory
    // and therefore never appears in the new-agent template picker. New
    // templates added to AGENT_TEMPLATES must also be categorized.
    const items: TemplateItem[] = Object.entries(AGENT_TEMPLATES)
      .filter(([id]) => id !== "custom")
      .map(([id, t]) => ({
        id,
        name: t.name,
        description: t.description,
        requiresDirectories: false,
        defaultTagline: t.defaultTagline,
        available: true,
      }));

    const result = groupTemplatesByCategory(items);
    const placed = new Set(result.categories.flatMap((c) => c.templates.map((t) => t.id)));
    const missing = items.map((i) => i.id).filter((id) => !placed.has(id));
    expect(missing, `templates without a category mapping: ${missing.join(", ")}`).toEqual([]);
  });

  it("assigns email-assistant to Email category", () => {
    const emailTemplate = {
      id: "email-assistant",
      name: "Email Assistant",
      description: "Read and draft emails",
      requiresDirectories: false,
      requiresEmailConnection: true,
      defaultTagline: "Read and draft emails",
      available: true,
    };
    const result = groupTemplatesByCategory([emailTemplate]);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].label).toBe("Email");
  });
});
