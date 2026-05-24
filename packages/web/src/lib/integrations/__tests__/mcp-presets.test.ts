import { describe, expect, it } from "vitest";
import { MCP_PRESETS, getMcpPreset } from "../mcp-presets";

describe("MCP_PRESETS", () => {
  it("exposes every Phase-1 preset", () => {
    // Notion and GitLab are intentionally absent — their hosted MCP servers
    // are OAuth-only as of May 2026. Tracked in #339 (Notion REST plugin)
    // and #340 (GitLab MCP when OAuth or upstream PAT support ships).
    expect(MCP_PRESETS.map((p) => p.id).sort()).toEqual([
      "atlassian",
      "cloudflare",
      "generic",
      "github",
      "highlevel",
      "intercom",
      "linear",
      "stripe",
    ]);
  });

  it("getMcpPreset returns generic as fallback for unknown ids", () => {
    expect(getMcpPreset("github").id).toBe("github");
    expect(getMcpPreset("atlassian").id).toBe("atlassian");
    expect(getMcpPreset("highlevel").id).toBe("highlevel");
    expect(getMcpPreset("unknown" as never).id).toBe("generic");
    // Notion and GitLab fall back to generic since they're not in Phase 1.
    expect(getMcpPreset("notion" as never).id).toBe("generic");
    expect(getMcpPreset("gitlab" as never).id).toBe("generic");
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
    // Anchor each pattern on the `https://` scheme so we don't accidentally
    // match an attacker-controlled prefix like `evil.com/github.com/...` —
    // CodeQL flags unanchored host substrings as a regex-misuse smell.
    const links: Record<string, RegExp> = {
      github: /https:\/\/github\.com\/settings\/personal-access-tokens/,
      linear: /https:\/\/linear\.app\/settings\/api/,
      atlassian: /https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens/,
      stripe: /https:\/\/dashboard\.stripe\.com\/apikeys/,
      cloudflare: /https:\/\/dash\.cloudflare\.com\/profile\/api-tokens/,
    };
    for (const [id, pattern] of Object.entries(links)) {
      const preset = MCP_PRESETS.find((p) => p.id === id);
      expect(preset, `preset ${id} should exist`).toBeDefined();
      expect(preset!.tokenInstructions).toMatch(pattern);
    }
  });
});
