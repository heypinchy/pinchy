import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/plugin-secrets-source", () => ({
  getOrCreatePluginSecret: vi.fn(),
}));

describe("collectPluginSecrets", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns pinchy-odoo.refTokenKey from the settings DB", async () => {
    const { getOrCreatePluginSecret } = await import("@/lib/plugin-secrets-source");
    const stored = "a".repeat(64);
    vi.mocked(getOrCreatePluginSecret).mockResolvedValue(stored);

    const { collectPluginSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    const result = await collectPluginSecrets();

    expect(result.plugins).toEqual({
      "pinchy-odoo": { refTokenKey: stored },
    });
    expect(getOrCreatePluginSecret).toHaveBeenCalledWith("pinchy-odoo:ref-token-key");
  });

  it("uses a stable identifier so the same key survives across regenerations", async () => {
    const { getOrCreatePluginSecret } = await import("@/lib/plugin-secrets-source");
    const stored = "b".repeat(64);
    vi.mocked(getOrCreatePluginSecret).mockResolvedValue(stored);

    const { collectPluginSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    await collectPluginSecrets();
    await collectPluginSecrets();

    expect(
      vi
        .mocked(getOrCreatePluginSecret)
        .mock.calls.every((call) => call[0] === "pinchy-odoo:ref-token-key")
    ).toBe(true);
  });
});

describe("buildSecretsBundle plugins passthrough", () => {
  it("writes the plugins map straight through to the bundle", async () => {
    const { buildSecretsBundle } = await import("@/lib/openclaw-config/secrets-bundle");
    const bundle = buildSecretsBundle({
      gateway: { token: "gw" },
      providers: {},
      integrations: {},
      plugins: { "pinchy-odoo": { refTokenKey: "c".repeat(64) } },
    });

    expect(bundle.plugins).toEqual({
      "pinchy-odoo": { refTokenKey: "c".repeat(64) },
    });
  });
});
