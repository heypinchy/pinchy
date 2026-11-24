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

  // Each key sits under a slot named for its slug AND the version of the key
  // (`<slug>@<keyVersion>`), so the SecretRef in openclaw.json changes whenever
  // the key does. A config that re-points a provider's base URL therefore
  // carries a pointer only the NEW key satisfies: OpenClaw can never pair the
  // new address with a stale resolved key, or the new key with the old address.
  it("carries each OpenAI-compatible instance's decrypted key under a slot versioned by its key (#894)", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { listProvidersWithApiKeys } = await import("@/lib/openai-compatible-providers");
    const swiss = {
      slug: "swisscom-ai",
      displayName: "Swisscom AI",
      baseUrl: "https://api.swisscom.example/v1",
      models: [],
      apiKey: "swiss-key",
      keyVersion: "0123456789abcdef",
    };
    const acme = {
      slug: "acme-llm",
      displayName: "Acme LLM",
      baseUrl: "https://acme.example/v1",
      models: [],
      apiKey: "acme-key",
      keyVersion: "fedcba9876543210",
    };
    vi.mocked(listProvidersWithApiKeys).mockResolvedValue([swiss, acme]);

    const { collectProviderSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    const result = await collectProviderSecrets();

    expect(result.providers["swisscom-ai@0123456789abcdef"]).toEqual({ apiKey: "swiss-key" });
    expect(result.providers["acme-llm@fedcba9876543210"]).toEqual({ apiKey: "acme-key" });
    expect(result.providers).not.toHaveProperty("swisscom-ai");
    // The same rows come back with their slot, so build.ts emits the base URL
    // and the pointer from the read that produced the key — never a second one.
    expect(result.customProviders).toEqual([
      { ...swiss, secretSlot: "swisscom-ai@0123456789abcdef" },
      { ...acme, secretSlot: "acme-llm@fedcba9876543210" },
    ]);
  });

  it("collects OpenAI-compatible keys via the single-query accessor, not per-slug (#894)", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { listProvidersWithApiKeys } = await import("@/lib/openai-compatible-providers");
    vi.mocked(listProvidersWithApiKeys).mockResolvedValue([
      {
        slug: "swisscom-ai",
        displayName: "Swisscom AI",
        baseUrl: "https://api.swisscom.example/v1",
        models: [],
        apiKey: "swiss-key",
        keyVersion: "0123456789abcdef",
      },
    ]);

    const { collectProviderSecrets } = await import("@/lib/openclaw-config/secrets-bundle");
    await collectProviderSecrets();

    // The N+1 / double-decrypt path is gone: one bulk accessor call decrypts
    // every provider's key — no per-slug round trip (the removed getDecryptedApiKey).
    expect(listProvidersWithApiKeys).toHaveBeenCalledTimes(1);
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
