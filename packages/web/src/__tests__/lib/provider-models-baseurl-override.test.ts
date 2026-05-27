import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Use the real providers module here — we need its actual
// resolveProviderBaseUrl, since that's what provider-models.ts wires through.
vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

import { fetchProviderModels, resetCache } from "@/lib/provider-models";
import { getSetting } from "@/lib/settings";

// The PROVIDER_FETCH_CONFIG URLs need to honor the same per-provider env
// overrides that validateProviderKey honors. Without this, the wizard's
// post-save regenerateOpenClawConfig() call (which calls getDefaultModel ->
// fetchProviderModels -> fetchModelsForProvider) hits the real provider API
// from the test container, masking smoke-test failures. For Google, the
// hardcoded URL also had the wrong API version (/v1/ instead of /v1beta/)
// which silently fell through to FALLBACK_MODELS instead of using the mock.

describe("provider-models baseUrl env override", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Return a minimal payload that satisfies the four transforms enough to
    // not NPE — each transform reads either `data` or `models`, both empty.
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: [], models: [] }), { status: 200 }));
    resetCache();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetCache();
    delete process.env.PINCHY_PROVIDER_BASEURL_OPENAI;
    delete process.env.PINCHY_PROVIDER_BASEURL_ANTHROPIC;
    delete process.env.PINCHY_PROVIDER_BASEURL_GOOGLE;
    delete process.env.PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD;
  });

  it.each([
    [
      "anthropic",
      "anthropic_api_key",
      "PINCHY_PROVIDER_BASEURL_ANTHROPIC",
      "/v1/models",
      "https://api.anthropic.com",
    ],
    [
      "openai",
      "openai_api_key",
      "PINCHY_PROVIDER_BASEURL_OPENAI",
      "/v1/models",
      "https://api.openai.com",
    ],
    [
      "google",
      "google_api_key",
      "PINCHY_PROVIDER_BASEURL_GOOGLE",
      "/v1beta/models",
      "https://generativelanguage.googleapis.com",
    ],
    [
      "ollama-cloud",
      "ollama_cloud_api_key",
      "PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD",
      "/v1/models",
      "https://ollama.com",
    ],
  ])(
    "model-listing for %s honors %s env override",
    async (provider, settingsKey, envVar, suffix, defaultBase) => {
      vi.mocked(getSetting).mockImplementation(async (key: string) => {
        if (key === settingsKey) return "test-key";
        return null;
      });

      // Override case
      process.env[envVar] = "http://mock";
      await fetchProviderModels();
      const overrideUrl = fetchSpy.mock.lastCall![0] as string;
      expect(overrideUrl).toContain("http://mock" + suffix);
      delete process.env[envVar];
      resetCache();

      // Fallback case
      await fetchProviderModels();
      const defaultUrl = fetchSpy.mock.lastCall![0] as string;
      expect(defaultUrl).toContain(defaultBase + suffix);
    }
  );
});
