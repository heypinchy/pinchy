import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES, getTemplate, generateAgentsMd } from "@/lib/agent-templates";

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
