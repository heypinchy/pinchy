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
});
