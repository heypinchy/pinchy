import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateProviderKey, PROVIDERS } from "@/lib/providers";

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

  it("should return invalid with error when both attempts return 401", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));

    const result = await validateProviderKey("anthropic", "sk-ant-invalid");
    expect(result).toEqual({ valid: false, error: "invalid_key" });
    // Should retry once before declaring invalid
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("should return valid when first attempt is 401 but retry succeeds", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("anthropic", "sk-ant-flaky");
    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("should not retry for non-401/403 errors", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));

    await validateProviderKey("anthropic", "sk-ant-key");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should return provider_error for 5xx responses", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));

    const result = await validateProviderKey("anthropic", "sk-ant-key");
    expect(result).toEqual({ valid: false, error: "provider_error", status: 500 });
  });

  it("should return provider_error for 429 rate limiting", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 429 }));

    const result = await validateProviderKey("anthropic", "sk-ant-key");
    expect(result).toEqual({ valid: false, error: "provider_error", status: 429 });
  });

  it("should return true for valid OpenAI key", async () => {
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

  it("should return true for valid Google key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("google", "AIza-valid");

    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1/models?key=AIza-valid",
      expect.any(Object)
    );
  });

  it("should return network_error on fetch failure", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    const result = await validateProviderKey("anthropic", "sk-ant-key");
    expect(result).toEqual({ valid: false, error: "network_error" });
  });

  it("should reject unknown provider", async () => {
    await expect(validateProviderKey("unknown" as any, "key")).rejects.toThrow("Unknown provider");
  });

  it("should return invalid_key for 403 Forbidden", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 403 }));

    const result = await validateProviderKey("anthropic", "sk-ant-key");
    expect(result).toEqual({ valid: false, error: "invalid_key" });
  });
});

describe("PROVIDERS", () => {
  it("should have default models for all providers", () => {
    expect(PROVIDERS.anthropic.defaultModel).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(PROVIDERS.openai.defaultModel).toBe("openai/gpt-4o-mini");
    expect(PROVIDERS.google.defaultModel).toBe("google/gemini-2.5-flash");
  });

  it("should have settings keys for all providers", () => {
    expect(PROVIDERS.anthropic.settingsKey).toBe("anthropic_api_key");
    expect(PROVIDERS.openai.settingsKey).toBe("openai_api_key");
    expect(PROVIDERS.google.settingsKey).toBe("google_api_key");
  });

  it("should have display names for all providers", () => {
    expect(PROVIDERS.anthropic.name).toBe("Anthropic");
    expect(PROVIDERS.openai.name).toBe("OpenAI");
    expect(PROVIDERS.google.name).toBe("Google");
  });

  it("should have placeholder text for all providers", () => {
    expect(PROVIDERS.anthropic.placeholder).toBe("sk-ant-...");
    expect(PROVIDERS.openai.placeholder).toBe("sk-...");
    expect(PROVIDERS.google.placeholder).toBe("AIza...");
  });
});
