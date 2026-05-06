import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-context");

// Mirrors build.ts:300-310 — apiBaseUrl/gatewayToken top-level, per-agent tools+userId.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
  agents: {
    "agent-uuid": {
      tools: ["save_user_context", "save_org_context"],
      userId: "user-uuid",
    },
  },
};

describe("pinchy-context manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires apiBaseUrl, gatewayToken, agents at the top level", () => {
    const partial = validatePluginEntry(manifest, { agents: {} });
    expect(partial.ok).toBe(false);
  });

  it("requires tools and userId per agent", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "test-token",
      agents: { "agent-uuid": { tools: ["save_user_context"] } },
    });
    expect(result.ok).toBe(false);
  });

  it("uses additionalProperties: false at the top level", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
