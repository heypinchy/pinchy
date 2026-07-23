import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/plugin-secrets-source", () => ({
  getOrCreatePluginSecret: vi.fn(),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
}));

// Generic "OpenAI-compatible" providers (#894) are DB-backed. Default to an
// empty list / no-key so the built-in-provider assertions below stay pure
// unit tests; the dedicated case overrides these to exercise key collection.
vi.mock("@/lib/openai-compatible-providers", () => ({
  listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
  listProvidersWithApiKeys: vi.fn().mockResolvedValue([]),
  getDecryptedApiKey: vi.fn().mockResolvedValue(null),
}));

describe("collectProviderSecrets", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does not emit a phantom apiKey for the URL-auth ollama-local provider", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "ollama_local_url" ? "http://host.docker.internal:11434" : null
    );

    const { collectProviderSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    const result = await collectProviderSecrets();

    // The local Ollama URL is not a secret; it must not appear as a credential.
    expect(result.providers).not.toHaveProperty("ollama-local");
  });

  it("still emits real api-key providers", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "anthropic_api_key" ? "sk-ant-real" : null
    );

    const { collectProviderSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    const result = await collectProviderSecrets();

    expect(result.providers.anthropic).toEqual({ apiKey: "sk-ant-real" });
  });

  it("carries each OpenAI-compatible instance's decrypted key under its slug (#894)", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { listProvidersWithApiKeys } = await import("@/lib/openai-compatible-providers");
    vi.mocked(listProvidersWithApiKeys).mockResolvedValue([
      { slug: "swisscom-ai", apiKey: "swiss-key" },
      { slug: "acme-llm", apiKey: "acme-key" },
    ]);

    const { collectProviderSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    const result = await collectProviderSecrets();

    expect(result.providers["swisscom-ai"]).toEqual({ apiKey: "swiss-key" });
    expect(result.providers["acme-llm"]).toEqual({ apiKey: "acme-key" });
  });

  it("collects OpenAI-compatible keys via the single-query accessor, not per-slug (#894)", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { listProvidersWithApiKeys, getDecryptedApiKey } =
      await import("@/lib/openai-compatible-providers");
    vi.mocked(listProvidersWithApiKeys).mockResolvedValue([
      { slug: "swisscom-ai", apiKey: "swiss-key" },
    ]);

    const { collectProviderSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    await collectProviderSecrets();

    // The N+1 / double-decrypt path is gone: one accessor call, no per-slug decrypt.
    expect(listProvidersWithApiKeys).toHaveBeenCalledTimes(1);
    expect(getDecryptedApiKey).not.toHaveBeenCalled();
  });
});

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
