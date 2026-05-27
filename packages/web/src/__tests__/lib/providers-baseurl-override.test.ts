import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateProviderKey, type ProviderName } from "@/lib/providers";

describe("validateProviderKey baseUrl env override", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.PINCHY_PROVIDER_BASEURL_OPENAI;
    delete process.env.PINCHY_PROVIDER_BASEURL_ANTHROPIC;
    delete process.env.PINCHY_PROVIDER_BASEURL_GOOGLE;
    delete process.env.PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD;
  });

  it("uses PINCHY_PROVIDER_BASEURL_OPENAI when set, falls back to api.openai.com otherwise", async () => {
    process.env.PINCHY_PROVIDER_BASEURL_OPENAI = "http://llm-mock:9100/openai";
    await validateProviderKey("openai", "sk-test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://llm-mock:9100/openai/v1/models",
      expect.any(Object)
    );

    delete process.env.PINCHY_PROVIDER_BASEURL_OPENAI;
    await validateProviderKey("openai", "sk-test");
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://api.openai.com/v1/models",
      expect.any(Object)
    );
  });

  it.each([
    ["anthropic", "PINCHY_PROVIDER_BASEURL_ANTHROPIC", "/v1/models", "https://api.anthropic.com"],
    [
      "google",
      "PINCHY_PROVIDER_BASEURL_GOOGLE",
      "/v1beta/models",
      "https://generativelanguage.googleapis.com",
    ],
    [
      "ollama-cloud",
      "PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD",
      "/v1/chat/completions",
      "https://ollama.com",
    ],
  ])("provider %s respects %s env override", async (provider, envVar, suffix, defaultBase) => {
    process.env[envVar] = "http://mock";
    await validateProviderKey(provider as ProviderName, "key");
    expect(fetchSpy.mock.lastCall![0]).toContain("http://mock" + suffix);
    delete process.env[envVar];

    // Fallback case — confirm we revert to the default base host.
    await validateProviderKey(provider as ProviderName, "key");
    expect(fetchSpy.mock.lastCall![0]).toContain(defaultBase + suffix);
  });
});
