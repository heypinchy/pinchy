import { describe, it, expect } from "vitest";
import { isRetiredModelError } from "@/lib/model-retirement";

describe("isRetiredModelError", () => {
  it("matches the HTTP 410 retired error we saw in production", () => {
    // Real audit row from pinchy.heypinchy.com (2026-06-24):
    expect(
      isRetiredModelError(
        new Error(
          'PDF model failed (ollama-cloud/qwen3-vl:235b-instruct): 410 "qwen3-vl:235b-instruct was retired at 2026-06-16 00:00:00 -0700 PDT"'
        )
      )
    ).toBe(true);
  });

  it("matches an Unknown model error", () => {
    expect(
      isRetiredModelError(new Error("Unknown model: ollama-cloud/gemini-2-preview-0514"))
    ).toBe(true);
  });

  it("matches model_not_found (OpenAI-style) and a plain string", () => {
    expect(isRetiredModelError("model_not_found")).toBe(true);
    expect(isRetiredModelError({ message: "the model was retired" })).toBe(true);
  });

  it("does NOT match a capability error (400 image not enabled) — re-resolve won't fix it", () => {
    expect(
      isRetiredModelError(
        new Error(
          'PDF model failed (ollama-cloud/devstral-small-2:24b): 400 "Image input is not enabled for this model"'
        )
      )
    ).toBe(false);
  });

  it("does NOT match unrelated errors or empty input", () => {
    expect(isRetiredModelError(new Error("Local media file not found"))).toBe(false);
    expect(isRetiredModelError(new Error("Expected PDF but got image/webp"))).toBe(false);
    expect(isRetiredModelError(undefined)).toBe(false);
    expect(isRetiredModelError(null)).toBe(false);
    expect(isRetiredModelError("")).toBe(false);
  });
});
