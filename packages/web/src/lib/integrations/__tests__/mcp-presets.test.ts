import { describe, expect, it } from "vitest";
import { MCP_PRESETS, getMcpPreset } from "../mcp-presets";

describe("MCP_PRESETS", () => {
  it("exposes every Phase-1 preset", () => {
    expect(MCP_PRESETS.map((p) => p.id).sort()).toEqual([
      "atlassian",
      "cloudflare",
      "generic",
      "github",
      "gitlab",
      "highlevel",
      "intercom",
      "linear",
      "notion",
      "stripe",
    ]);
  });

  it("getMcpPreset returns generic as fallback for unknown ids", () => {
    expect(getMcpPreset("github").id).toBe("github");
    expect(getMcpPreset("atlassian").id).toBe("atlassian");
    expect(getMcpPreset("highlevel").id).toBe("highlevel");
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

  it("toolPrefix values are unique across presets", () => {
    // Two presets with the same prefix would conflict when both are connected
    // to the same agent — the plugin would register colliding tool names.
    const prefixes = MCP_PRESETS.map((p) => p.toolPrefix);
    expect(prefixes).toEqual(Array.from(new Set(prefixes)));
  });

  it("tokenInstructions reference the provider's canonical credential page", () => {
    // Quick smoke check that the markdown copy points at the current
    // 2026 URLs — guards against the kind of stale-link regression we saw
    // with GitHub's old ?type=beta URL.
    const links: Record<string, RegExp> = {
      github: /github\.com\/settings\/personal-access-tokens/,
      notion: /notion\.so\/my-integrations/,
      linear: /linear\.app\/settings\/api/,
      atlassian: /id\.atlassian\.com\/manage-profile\/security\/api-tokens/,
      gitlab: /gitlab\.com\/-\/user_settings\/personal_access_tokens/,
      stripe: /dashboard\.stripe\.com\/apikeys/,
      cloudflare: /dash\.cloudflare\.com\/profile\/api-tokens/,
    };
    for (const [id, pattern] of Object.entries(links)) {
      const preset = MCP_PRESETS.find((p) => p.id === id);
      expect(preset, `preset ${id} should exist`).toBeDefined();
      expect(preset!.tokenInstructions).toMatch(pattern);
    }
  });
});
