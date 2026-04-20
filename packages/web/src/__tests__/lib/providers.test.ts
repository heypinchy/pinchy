import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateProviderKey, validateProviderUrl, PROVIDERS } from "@/lib/providers";

global.fetch = vi.fn();

describe("validateProviderKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return valid for valid Anthropic key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("anthropic", "sk-ant-valid");

    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-ant-valid",
        }),
      })
    );
  });

  it("should return invalid_key for 401 after retry", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));

    const result = await validateProviderKey("anthropic", "sk-ant-invalid");
    expect(result).toEqual({ valid: false, error: "invalid_key" });
    // Should have retried once (2 calls total)
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("should succeed on retry when first call returns 401", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("anthropic", "sk-ant-transient");
    expect(result).toEqual({ valid: true });
  });

  it("should return provider_error for 429/5xx", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 429 }));

    const result = await validateProviderKey("anthropic", "sk-ant-key");
    expect(result).toEqual({ valid: false, error: "provider_error", status: 429 });
  });

  it("should return valid for valid OpenAI key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("openai", "sk-valid");

    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-valid",
        }),
      })
    );
  });

  it("should return valid for valid Google key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("google", "AIza-valid");

    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1/models?key=AIza-valid",
      expect.any(Object)
    );
  });

  // Ollama Cloud's /v1/models is a public catalog — it returns 200 with the full
  // model list regardless of whether the Bearer token is valid. Validating against
  // that endpoint accepted any string as a valid key. The real auth boundary is
  // /v1/chat/completions: auth is checked before body validation, so an empty
  // body with a valid key gets 400, and with an invalid key gets 401.
  it("should validate Ollama Cloud keys via chat/completions (auth-protected), not models (public catalog)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"error":"messages required"}', { status: 400 })
    );
    const result = await validateProviderKey("ollama-cloud", "sk-ollama-valid");
    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://ollama.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-ollama-valid",
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("should reject Ollama Cloud key when chat endpoint returns 401, even if models catalog would return 200", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      // Mirror real Ollama Cloud behavior:
      // - /v1/models: public catalog, returns 200 for any Bearer token.
      // - /v1/chat/completions: auth-protected, returns 401 for bad tokens.
      if (u.includes("/v1/chat/completions")) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    });
    const result = await validateProviderKey("ollama-cloud", "bogus-key");
    expect(result).toEqual({ valid: false, error: "invalid_key" });
  });

  it("should return network_error on fetch failure", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const result = await validateProviderKey("anthropic", "sk-ant-key");
    expect(result).toEqual({ valid: false, error: "network_error" });
  });

  it("should reject unknown provider", async () => {
    await expect(validateProviderKey("unknown" as any, "key")).rejects.toThrow("Unknown provider");
  });
});

describe("PROVIDERS", () => {
  it("should have default models for all providers", () => {
    expect(PROVIDERS.anthropic.defaultModel).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(PROVIDERS.openai.defaultModel).toBe("openai/gpt-4o-mini");
    expect(PROVIDERS.google.defaultModel).toBe("google/gemini-2.5-flash");
    expect(PROVIDERS["ollama-cloud"].defaultModel).toBe("ollama-cloud/gemini-3-flash-preview");
  });

  it("should have settings keys for all providers", () => {
    expect(PROVIDERS.anthropic.settingsKey).toBe("anthropic_api_key");
    expect(PROVIDERS.openai.settingsKey).toBe("openai_api_key");
    expect(PROVIDERS.google.settingsKey).toBe("google_api_key");
    expect(PROVIDERS["ollama-cloud"].settingsKey).toBe("ollama_cloud_api_key");
  });

  it("should have ollama-local provider with URL config", () => {
    expect(PROVIDERS["ollama-local"]).toBeDefined();
    expect(PROVIDERS["ollama-local"].name).toBe("Ollama (Local)");
    expect(PROVIDERS["ollama-local"].settingsKey).toBe("ollama_local_url");
    expect(PROVIDERS["ollama-local"].authType).toBe("url");
  });

  it("should have authType api-key for all API key providers", () => {
    expect(PROVIDERS.anthropic.authType).toBe("api-key");
    expect(PROVIDERS.openai.authType).toBe("api-key");
    expect(PROVIDERS.google.authType).toBe("api-key");
    expect(PROVIDERS["ollama-cloud"].authType).toBe("api-key");
  });
});

describe("validateProviderUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return valid when Ollama is reachable", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    );
    const result = await validateProviderUrl("http://localhost:11434");
    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
  });

  it("should strip trailing slash from URL", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    await validateProviderUrl("http://localhost:11434/");
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
  });

  it("should return network_error when Ollama is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await validateProviderUrl("http://localhost:11434");
    expect(result).toEqual({ valid: false, error: "network_error" });
  });

  it("should return provider_error for non-ok status", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));
    const result = await validateProviderUrl("http://localhost:11434");
    expect(result).toEqual({ valid: false, error: "provider_error", status: 500 });
  });
});
