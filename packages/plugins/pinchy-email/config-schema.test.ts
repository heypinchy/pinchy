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
      validatePluginEntry(manifest, {
        apiBaseUrl: "http://x",
        gatewayToken: "t",
      }).ok
    ).toBe(false);
  });

  it("requires connectionId and permissions per agent (tools is optional)", () => {
    expect(
      validatePluginEntry(manifest, {
        apiBaseUrl: "http://x",
        gatewayToken: "t",
        agents: { "a-1": { connectionId: "c-1" } },
      }).ok
    ).toBe(false);
  });

  // Migration test -- see AGENTS.md "Test Migrations Against Pre-Existing
  // Data". Pre-upgrade regenerateOpenClawConfig() wrote agent entries with
  // only connectionId+permissions (no "tools"). If an upgraded OpenClaw
  // container (new plugin manifest) loads a stale openclaw.json written by
  // that old code before Pinchy regenerates config, schema validation must
  // not reject it -- or all email tools vanish for every agent on that
  // installation. "tools" is intentionally NOT in the manifest's required
  // list so old-shaped entries keep validating; it is still declared as a
  // property for the shape build.ts emits today.
  it("validates an old-shape agent entry (connectionId+permissions, no tools) written by pre-upgrade code", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "http://x",
      gatewayToken: "t",
      agents: {
        "a-1": {
          connectionId: "c-1",
          permissions: { email: ["read"] },
        },
      },
    });
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("uses additionalProperties: false", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it("declares contracts.tools with all email tool names", () => {
    expect(manifest.contracts?.tools?.slice().sort()).toEqual([
      "email_draft",
      "email_get_attachment",
      "email_list",
      "email_read",
      "email_search",
      "email_send",
    ]);
  });
});
