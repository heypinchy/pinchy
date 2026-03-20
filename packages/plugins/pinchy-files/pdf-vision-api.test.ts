import { describe, it, expect, vi, afterEach } from "vitest";
import { describePageImage } from "./pdf-vision-api";

describe("describePageImage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls Anthropic API with correct format for anthropic models", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Extracted text from page" }],
      }),
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toBe("Extracted text from page");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns null when API key is not available", async () => {
    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => null,
    });

    expect(result).toBeNull();
  });

  it("returns null for unknown providers", async () => {
    const result = await describePageImage("base64data", {
      model: "ollama/llama3.1:8b",
      resolveApiKey: async () => "key",
    });

    expect(result).toBeNull();
  });

  it("returns null on API error (non-retryable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toBeNull();
  });

  it("retries on 429 rate limit and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        text: async () => "Rate limited",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Extracted after retry" }],
        }),
      });
    globalThis.fetch = mockFetch;

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toBe("Extracted after retry");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after max retries on repeated 429", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "0" }),
      text: async () => "Rate limited",
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toBeNull();
    // Should have retried a few times (3 max)
    expect((globalThis.fetch as any).mock.calls.length).toBeLessThanOrEqual(4);
  });
});
