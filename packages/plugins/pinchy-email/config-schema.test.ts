// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-email");

// Mirrors build.ts — top-level api fields, per-agent connectionId+permissions+tools.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
  agents: {
    "agent-uuid": {
      connectionId: "conn-uuid",
      permissions: { email: ["read", "search"] },
      tools: ["email_list", "email_read", "email_search"],
    },
  },
};

describe("pinchy-email manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires apiBaseUrl and gatewayToken (missing either fails)", () => {
    expect(validatePluginEntry(manifest, { agents: {} }).ok).toBe(false);
  });

  it("requires agents at the top level (missing agents fails)", () => {
    expect(
      validatePluginEntry(manifest, { apiBaseUrl: "http://x", gatewayToken: "t" }).ok,
    ).toBe(false);
  });

  it("requires connectionId, permissions, and tools per agent", () => {
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

  it("declares contracts.tools with all email tool names", () => {
    const contracts = (manifest as Record<string, unknown>).contracts as
      | { tools?: string[] }
      | undefined;
    expect(contracts?.tools?.toSorted()).toEqual(
      ["email_draft", "email_list", "email_read", "email_search", "email_send"],
    );
  });
});
