import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-mcp");

// Representative config that regenerateOpenClawConfig() will write (Pattern B).
// The plugin never receives credentials — it fetches them via the internal API.
const REPRESENTATIVE_EMITTED_CONFIG = {
  apiBaseUrl: "http://pinchy:7777/",
  gatewayToken: "test-bootstrap-token",
  connections: [
    {
      connectionId: "conn_abc",
      preset: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      toolPrefix: "github_",
      agentTools: { agent_xyz: ["create_issue", "list_repos"] },
    },
  ],
};

describe("pinchy-mcp manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("rejects config with an unknown root key (additionalProperties: false)", () => {
    const result = validatePluginEntry(manifest, {
      ...REPRESENTATIVE_EMITTED_CONFIG,
      unexpectedField: "value",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects config with an unknown key in a connection item", () => {
    const result = validatePluginEntry(manifest, {
      ...REPRESENTATIVE_EMITTED_CONFIG,
      connections: [
        {
          ...REPRESENTATIVE_EMITTED_CONFIG.connections[0],
          secretApiKey: "should-not-be-here",
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects config missing the required apiBaseUrl field", () => {
    const { apiBaseUrl: _omitted, ...withoutBaseUrl } = REPRESENTATIVE_EMITTED_CONFIG;
    const result = validatePluginEntry(manifest, withoutBaseUrl);
    expect(result.ok).toBe(false);
  });

  it("accepts an empty connections array", () => {
    const result = validatePluginEntry(manifest, {
      ...REPRESENTATIVE_EMITTED_CONFIG,
      connections: [],
    });
    expect(result.ok).toBe(true);
  });

  it("uses additionalProperties: false at the root", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
