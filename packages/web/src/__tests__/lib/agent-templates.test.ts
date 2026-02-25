import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES, getTemplate } from "@/lib/agent-templates";

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
