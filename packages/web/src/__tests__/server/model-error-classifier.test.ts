import { describe, it, expect } from "vitest";
import { classifyModelError } from "@/server/model-error-classifier";

describe("classifyModelError", () => {
  it("matches HTTP 500 with ref and returns model_unavailable", () => {
    const result = classifyModelError(
      'HTTP 500: "Internal Server Error (ref: abc-123)"',
      "ollama-cloud/kimi-k2-thinking"
    );
    expect(result).toEqual({
      kind: "model_unavailable",
      model: "ollama-cloud/kimi-k2-thinking",
      httpStatus: 500,
      ref: "abc-123",
    });
  });

  it.each([502, 503, 504])("matches HTTP %i", (status) => {
    const result = classifyModelError(`HTTP ${status}: upstream error`, "anthropic/claude-x");
    expect(result?.kind).toBe("model_unavailable");
    expect(result?.httpStatus).toBe(status);
  });

  it("returns null for 4xx errors (those are auth/config, handled elsewhere)", () => {
    expect(classifyModelError("HTTP 401: Unauthorized", "openai/gpt-x")).toBeNull();
    expect(classifyModelError("HTTP 429: Too Many Requests", "openai/gpt-x")).toBeNull();
  });

  it("returns null when error text has no HTTP status", () => {
    expect(classifyModelError("Network unreachable", "openai/gpt-x")).toBeNull();
  });

  it("returns null for empty model identifier", () => {
    expect(classifyModelError("HTTP 500: oops", "")).toBeNull();
  });

  it("matches HTTP 5xx without ref (some providers omit it)", () => {
    const result = classifyModelError("HTTP 503: Service Unavailable", "google/gemini-2");
    expect(result).toEqual({
      kind: "model_unavailable",
      model: "google/gemini-2",
      httpStatus: 503,
      ref: undefined,
    });
  });

  it("works for any provider prefix (provider-agnostic)", () => {
    for (const model of [
      "openai/gpt-5.5",
      "anthropic/claude-opus-4-7",
      "google/gemini-3-flash-preview",
      "ollama-cloud/deepseek-v4-pro",
    ]) {
      const result = classifyModelError("HTTP 500: boom", model);
      expect(result?.model).toBe(model);
    }
  });
});
