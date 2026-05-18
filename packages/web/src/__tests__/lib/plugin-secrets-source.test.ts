import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

describe("getOrCreatePluginSecret", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns the existing secret from settings without generating a new one", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    const stored = "a".repeat(64);
    vi.mocked(getSetting).mockResolvedValue(stored);

    const { getOrCreatePluginSecret } = await import("@/lib/plugin-secrets-source");
    const secret = await getOrCreatePluginSecret("pinchy-odoo:ref-token-key");

    expect(secret).toBe(stored);
    expect(getSetting).toHaveBeenCalledWith("plugin_secret:pinchy-odoo:ref-token-key");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("generates a 64-hex-char secret when none exists", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { getOrCreatePluginSecret } = await import("@/lib/plugin-secrets-source");
    const secret = await getOrCreatePluginSecret("pinchy-odoo:ref-token-key");

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(setSetting).toHaveBeenCalledWith("plugin_secret:pinchy-odoo:ref-token-key", secret);
  });

  it("rejects malformed stored values (not 64 hex chars) and regenerates", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue("not-hex-at-all");

    const { getOrCreatePluginSecret } = await import("@/lib/plugin-secrets-source");
    const secret = await getOrCreatePluginSecret("pinchy-odoo:ref-token-key");

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(setSetting).toHaveBeenCalledWith("plugin_secret:pinchy-odoo:ref-token-key", secret);
  });

  it("namespaces different secret names independently", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { getOrCreatePluginSecret } = await import("@/lib/plugin-secrets-source");
    await getOrCreatePluginSecret("foo");
    await getOrCreatePluginSecret("bar");

    expect(getSetting).toHaveBeenCalledWith("plugin_secret:foo");
    expect(getSetting).toHaveBeenCalledWith("plugin_secret:bar");
  });
});
