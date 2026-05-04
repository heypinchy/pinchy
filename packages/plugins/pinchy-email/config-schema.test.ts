import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-email");

// Mirrors build.ts:507-517 — top-level api fields, per-agent connectionId+permissions.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
  agents: {
    "agent-uuid": {
      connectionId: "conn-uuid",
      permissions: { "messages.send": ["send"] },
    },
  },
};

describe("pinchy-email manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires apiBaseUrl, gatewayToken, agents at the top level", () => {
    expect(validatePluginEntry(manifest, { agents: {} }).ok).toBe(false);
  });

  it("requires connectionId and permissions per agent", () => {
    expect(
      validatePluginEntry(manifest, {
        apiBaseUrl: "http://x",
        gatewayToken: "t",
        agents: { "a-1": { connectionId: "c-1" } },
      }).ok,
    ).toBe(false);
  });

  it("uses additionalProperties: false", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
