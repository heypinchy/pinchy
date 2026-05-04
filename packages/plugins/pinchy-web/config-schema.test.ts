import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-web");

// Mirrors build.ts:452-461 — top-level apiBaseUrl + gatewayToken + connectionId,
// per-agent tools (required) plus optional domain/locale filters.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
  connectionId: "conn-uuid",
  agents: {
    "agent-uuid": {
      tools: ["pinchy_web_search", "pinchy_web_fetch"],
      allowedDomains: ["example.com"],
      excludedDomains: ["spam.example"],
      language: "de",
      country: "AT",
      freshness: "month",
    },
  },
};

describe("pinchy-web manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires apiBaseUrl, gatewayToken, connectionId, agents at the top level", () => {
    expect(validatePluginEntry(manifest, { agents: {} }).ok).toBe(false);
  });

  it("requires tools per agent", () => {
    expect(
      validatePluginEntry(manifest, {
        apiBaseUrl: "x",
        gatewayToken: "t",
        connectionId: "c",
        agents: { "a-1": {} },
      }).ok,
    ).toBe(false);
  });

  it("rejects the legacy braveApiKey field (pre-#209)", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "x",
      gatewayToken: "t",
      connectionId: "c",
      braveApiKey: "sk-...",
      agents: { "a-1": { tools: [] } },
    });
    expect(result.ok).toBe(false);
  });

  it("uses additionalProperties: false", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
