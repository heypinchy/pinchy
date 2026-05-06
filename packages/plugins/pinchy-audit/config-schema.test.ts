import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-audit");

// Mirrors build.ts:314-320 — pinchy-audit has no per-agent config, just credentials.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
};

describe("pinchy-audit manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires apiBaseUrl and gatewayToken", () => {
    expect(validatePluginEntry(manifest, {}).ok).toBe(false);
    expect(validatePluginEntry(manifest, { apiBaseUrl: "x" }).ok).toBe(false);
    expect(validatePluginEntry(manifest, { gatewayToken: "x" }).ok).toBe(false);
  });

  it("uses additionalProperties: false", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
