import { describe, it, expect } from "vitest";
import {
  AGENT_TEMPLATES,
  getTemplate,
  getTemplateList,
  generateAgentsMd,
} from "@/lib/agent-templates";

describe("agent-templates", () => {
  it("should have a knowledge-base template", () => {
    expect(AGENT_TEMPLATES["knowledge-base"]).toBeDefined();
    expect(AGENT_TEMPLATES["knowledge-base"].name).toBe("Knowledge Base");
    expect(AGENT_TEMPLATES["knowledge-base"].pluginId).toBe("pinchy-files");
    expect(AGENT_TEMPLATES["knowledge-base"].allowedTools).toEqual(["pinchy_ls", "pinchy_read"]);
  });

  it("should have a custom template with no allowed tools", () => {
    expect(AGENT_TEMPLATES["custom"]).toBeDefined();
    expect(AGENT_TEMPLATES["custom"].pluginId).toBeNull();
    expect(AGENT_TEMPLATES["custom"].allowedTools).toEqual([]);
  });

  it("should return template by id", () => {
    expect(getTemplate("knowledge-base")).toBe(AGENT_TEMPLATES["knowledge-base"]);
  });

  it("should return undefined for unknown template", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });

  it("knowledge-base should use the-professor personality", () => {
    expect(AGENT_TEMPLATES["knowledge-base"].defaultPersonality).toBe("the-professor");
  });

  it("custom should use the-butler personality", () => {
    expect(AGENT_TEMPLATES["custom"].defaultPersonality).toBe("the-butler");
  });

  it("knowledge-base should have a defaultTagline", () => {
    expect(AGENT_TEMPLATES["knowledge-base"].defaultTagline).toBe(
      "Answer questions from your docs"
    );
  });

  it("custom should have null defaultTagline", () => {
    expect(AGENT_TEMPLATES["custom"].defaultTagline).toBeNull();
  });

  it("should not have old defaultSoulMd or defaultGreeting fields", () => {
    const kb = AGENT_TEMPLATES["knowledge-base"] as Record<string, unknown>;
    expect(kb.defaultSoulMd).toBeUndefined();
    expect(kb.defaultGreeting).toBeUndefined();
  });

  it("all templates should have defaultAgentsMd field", () => {
    for (const template of Object.values(AGENT_TEMPLATES)) {
      expect(template).toHaveProperty("defaultAgentsMd");
    }
  });

  it("knowledge-base should have non-null defaultAgentsMd with document-answering instructions", () => {
    const kb = AGENT_TEMPLATES["knowledge-base"];
    expect(kb.defaultAgentsMd).not.toBeNull();
    expect(kb.defaultAgentsMd).toContain("knowledge base agent");
    expect(kb.defaultAgentsMd).toContain("cite");
  });

  it("custom should have null defaultAgentsMd", () => {
    expect(AGENT_TEMPLATES["custom"].defaultAgentsMd).toBeNull();
  });
});

describe("generateAgentsMd", () => {
  it("should include allowed paths for knowledge-base template", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/hr-docs/"] });
    expect(content).toContain("/data/hr-docs/");
  });

  it("should instruct the agent to use pinchy_ls before reading files", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/hr-docs/"] });
    expect(content).toContain("pinchy_ls");
  });

  it("should preserve the base knowledge base instructions", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/hr-docs/"] });
    expect(content).toContain("knowledge base agent");
    expect(content).toContain("cite");
  });

  it("should include all provided paths when multiple paths given", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/docs/", "/data/hr/"] });
    expect(content).toContain("/data/docs/");
    expect(content).toContain("/data/hr/");
  });

  it("should return defaultAgentsMd unchanged for custom template", () => {
    const template = AGENT_TEMPLATES["custom"];
    const content = generateAgentsMd(template, undefined);
    expect(content).toBe(template.defaultAgentsMd);
  });

  it("should return defaultAgentsMd when no pluginConfig provided for knowledge-base", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, undefined);
    expect(content).toBe(template.defaultAgentsMd);
  });
});

describe("Odoo templates", () => {
  it("all 6 odoo templates exist", () => {
    const ids = [
      "odoo-sales-analyst",
      "odoo-inventory-scout",
      "odoo-finance-controller",
      "odoo-crm-assistant",
      "odoo-procurement-agent",
      "odoo-customer-service",
    ];
    for (const id of ids) {
      expect(getTemplate(id)).toBeDefined();
    }
  });

  it("odoo templates have requiresOdooConnection flag", () => {
    const t = getTemplate("odoo-sales-analyst");
    expect(t!.requiresOdooConnection).toBe(true);
  });

  it("odoo templates have odooConfig with accessLevel and requiredModels", () => {
    const t = getTemplate("odoo-sales-analyst");
    expect(t!.odooConfig).toBeDefined();
    expect(t!.odooConfig!.accessLevel).toBe("read-only");
    expect(t!.odooConfig!.requiredModels.length).toBeGreaterThan(0);
    expect(t!.odooConfig!.requiredModels[0]).toHaveProperty("model");
    expect(t!.odooConfig!.requiredModels[0]).toHaveProperty("operations");
  });

  it("read-only templates have only read tools", () => {
    const t = getTemplate("odoo-sales-analyst")!;
    expect(t.allowedTools).toContain("odoo_schema");
    expect(t.allowedTools).toContain("odoo_read");
    expect(t.allowedTools).not.toContain("odoo_create");
    expect(t.allowedTools).not.toContain("odoo_write");
  });

  it("read-write templates have read and write tools", () => {
    const t = getTemplate("odoo-crm-assistant")!;
    expect(t.allowedTools).toContain("odoo_read");
    expect(t.allowedTools).toContain("odoo_create");
    expect(t.allowedTools).toContain("odoo_write");
    expect(t.allowedTools).not.toContain("odoo_delete");
  });

  it("getTemplateList includes all odoo templates", () => {
    const list = getTemplateList();
    expect(list.length).toBeGreaterThanOrEqual(8); // 2 existing + 6 new
    expect(list.some((t) => t.id === "odoo-sales-analyst")).toBe(true);
    expect(list.some((t) => t.id === "odoo-customer-service")).toBe(true);
  });

  it("existing templates are not affected", () => {
    expect(getTemplate("knowledge-base")).toBeDefined();
    expect(getTemplate("custom")).toBeDefined();
    expect(getTemplate("knowledge-base")!.requiresOdooConnection).toBeFalsy();
  });
});
