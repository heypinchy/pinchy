import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-files");

// Mirrors the shape regenerateOpenClawConfig() emits at packages/web/src/lib/openclaw-config/build.ts:260-270.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
  agents: {
    "agent-uuid": {
      allowed_paths: ["/data/knowledge-base"],
    },
  },
};

describe("pinchy-files manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("rejects an empty config (agents is required)", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "test-token",
    });
    expect(result.ok).toBe(false);
  });

  it("uses additionalProperties: false at the top level", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
