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

  it("tokenUrl points at the provider's canonical credential page", () => {
    // Guards against the kind of stale-link regression we saw with GitHub's
    // old ?type=beta URL. Exact-equality on the structured `tokenUrl` field
    // (rendered as the CTA button) — stricter than the previous substring
    // match against the markdown blob, and avoids CodeQL's
    // js/regex/missing-regexp-anchor smell on URL-shaped patterns.
    const links: Record<string, string> = {
      github: "https://github.com/settings/personal-access-tokens",
      linear: "https://linear.app/settings/api",
      atlassian: "https://id.atlassian.com/manage-profile/security/api-tokens",
      stripe: "https://dashboard.stripe.com/apikeys",
      cloudflare: "https://dash.cloudflare.com/profile/api-tokens",
    };
    for (const [id, expectedUrl] of Object.entries(links)) {
      const preset = MCP_PRESETS.find((p) => p.id === id);
      expect(preset, `preset ${id} should exist`).toBeDefined();
      expect(preset!.tokenUrl).toBe(expectedUrl);
    }
  });

  it("every credentialed preset ships a setup walkthrough; a CTA label accompanies every tokenUrl", () => {
    // Generic has no provider-specific guidance (the custom flow shows raw
    // URL + token fields). HighLevel's token is created in-app, so it has
    // steps but no tokenUrl. Everything else must give the user a walkthrough.
    for (const p of MCP_PRESETS.filter((x) => x.id !== "generic")) {
      expect(p.setupSteps, `${p.id} should have setup steps`).toBeTruthy();
      // A CTA button without a label is useless; a label without a URL has
      // nothing to link to. They travel together.
      expect(Boolean(p.tokenUrl), `${p.id} tokenUrl/label must agree`).toBe(
        Boolean(p.tokenUrlLabel)
      );
    }
  });
});
