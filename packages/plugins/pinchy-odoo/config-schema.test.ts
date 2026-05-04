import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-odoo");

// Mirrors build.ts:403-419 exactly — connectionId (NOT connection), permissions, modelNames.
// Plus top-level apiBaseUrl + gatewayToken used by the plugin's credential-fetch path.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token",
  agents: {
    "agent-uuid": {
      connectionId: "conn-uuid",
      permissions: {
        "crm.lead": ["read", "create"],
        "res.partner": ["read"],
      },
      modelNames: {
        "crm.lead": "Leads & Opportunities",
        "res.partner": "Contacts",
      },
    },
  },
};

describe("pinchy-odoo manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires apiBaseUrl, gatewayToken, agents at the top level", () => {
    expect(validatePluginEntry(manifest, { agents: {} }).ok).toBe(false);
  });

  it("requires connectionId and permissions per agent (modelNames optional)", () => {
    const noConnId = validatePluginEntry(manifest, {
      apiBaseUrl: "x",
      gatewayToken: "t",
      agents: { "a-1": { permissions: {} } },
    });
    expect(noConnId.ok).toBe(false);

    const noPerms = validatePluginEntry(manifest, {
      apiBaseUrl: "x",
      gatewayToken: "t",
      agents: { "a-1": { connectionId: "c-1" } },
    });
    expect(noPerms.ok).toBe(false);

    const noModelNames = validatePluginEntry(manifest, {
      apiBaseUrl: "x",
      gatewayToken: "t",
      agents: { "a-1": { connectionId: "c-1", permissions: {} } },
    });
    expect(noModelNames.ok).toBe(true);
  });

  it("rejects the legacy connection (object) field that pre-#209 builds wrote", () => {
    const result = validatePluginEntry(manifest, {
      apiBaseUrl: "x",
      gatewayToken: "t",
      agents: {
        "a-1": {
          connection: { url: "x", db: "x", uid: 1, apiKey: "x" },
          permissions: {},
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("uses additionalProperties: false", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
