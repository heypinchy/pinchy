// @vitest-environment node
/**
 * Validates that the pinchy-knowledge plugin configSchema declares exactly
 * the fields Pinchy's regenerateOpenClawConfig() writes into it — no more,
 * no less (additionalProperties: false). See pinchy-context/pinchy-docs for
 * the same contract on the other credential-proxy internal plugins.
 */
import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-knowledge");

// Mirrors the entries["pinchy-knowledge"] block in build.ts: apiBaseUrl/
// gatewayToken top-level (credential-proxy pattern, same as pinchy-context),
// agents map to empty objects — presence-only per-agent gating, since
// knowledge_search takes no per-agent parameters beyond "is this agent
// allowed to call it" (same shape as pinchy-docs's agents map).
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
  agents: {
    "agent-uuid": {},
  },
};

describe("pinchy-knowledge manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires apiBaseUrl at the top level", () => {
    const result = validatePluginEntry(manifest, {
      gatewayToken: "test-token",
      agents: {},
    });
    expect(result.ok).toBe(false);
  });

  it("requires gatewayToken at the top level", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "http://pinchy:7777",
      agents: {},
    });
    expect(result.ok).toBe(false);
  });

  it("requires agents at the top level", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "test-token",
    });
    expect(result.ok).toBe(false);
  });

  it("uses additionalProperties: false at the top level", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    const result = validatePluginEntry(manifest, {
      ...REPRESENTATIVE_EMITTED_CONFIG,
      evilField: "x",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts multiple agents mapped to empty objects", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "test-token",
      agents: { "agent-1": {}, "agent-2": {} },
    });
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });
});
