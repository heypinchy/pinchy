import { describe, expect, it } from "vitest";
import { MCP_PRESETS, getMcpPreset } from "../mcp-presets";

describe("MCP_PRESETS", () => {
  it("exposes the four Phase-1 presets", () => {
    expect(MCP_PRESETS.map((p) => p.id).sort()).toEqual(["generic", "github", "linear", "notion"]);
  });

  it("getMcpPreset returns generic as fallback for unknown ids", () => {
    expect(getMcpPreset("github").id).toBe("github");
    expect(getMcpPreset("unknown" as never).id).toBe("generic");
  });

  it("non-generic presets have a defaultUrl", () => {
    for (const p of MCP_PRESETS.filter((p) => p.id !== "generic")) {
      expect(p.defaultUrl).toMatch(/^https:\/\//);
    }
  });

  it("toolPrefix is a stable lowercase identifier", () => {
    for (const p of MCP_PRESETS) {
      expect(p.toolPrefix).toMatch(/^[a-z]+_$/);
    }
  });
});
