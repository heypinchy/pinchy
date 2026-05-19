import { describe, it, expect } from "vitest";
import { classifyModelError, classifyUpstreamFormatError } from "@/server/model-error-classifier";

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

describe("classifyUpstreamFormatError", () => {
  // Production payload shape (issue #338, prod gateway log 2026-05-11):
  //   LLM request failed: provider rejected the request schema or tool payload.
  //   rawError=400 "Function call is missing a thought_signature in functionCall parts. (ref: ...)"
  const PROD_ERROR_TEXT =
    "LLM request failed: provider rejected the request schema or tool payload. " +
    'rawError=400 "Function call is missing a thought_signature in functionCall parts. ' +
    '(ref: 3d5cf450-a3f6-4566-a1db-a7c5c0515cc0)"';

  it("matches the thought_signature pattern and returns upstream_format_error", () => {
    const result = classifyUpstreamFormatError(
      PROD_ERROR_TEXT,
      "ollama-cloud/gemini-3-flash-preview"
    );
    expect(result).toEqual({
      kind: "upstream_format_error",
      model: "ollama-cloud/gemini-3-flash-preview",
      errorPattern: "thought_signature",
      ref: "3d5cf450-a3f6-4566-a1db-a7c5c0515cc0",
    });
  });

  it("matches camelCase 'thoughtSignature' variant (some replay paths use it)", () => {
    const result = classifyUpstreamFormatError(
      "Function call is missing a thoughtSignature in functionCall parts.",
      "google/gemini-3-pro"
    );
    expect(result?.kind).toBe("upstream_format_error");
    expect(result?.errorPattern).toBe("thought_signature");
  });

  it("returns null when the pattern is absent", () => {
    expect(
      classifyUpstreamFormatError("HTTP 500: Internal Server Error", "google/gemini-3-pro")
    ).toBeNull();
    expect(
      classifyUpstreamFormatError(
        "rawError=400 schema validation failed for tool foo",
        "google/gemini-3-pro"
      )
    ).toBeNull();
  });

  it("returns null for empty model identifier", () => {
    expect(classifyUpstreamFormatError(PROD_ERROR_TEXT, "")).toBeNull();
  });

  it("matches even when ref is missing (some OC error frames omit it)", () => {
    const result = classifyUpstreamFormatError(
      "rawError=400 missing thought_signature in functionCall parts.",
      "ollama-cloud/gemini-3-flash-preview"
    );
    expect(result).toEqual({
      kind: "upstream_format_error",
      model: "ollama-cloud/gemini-3-flash-preview",
      errorPattern: "thought_signature",
      ref: undefined,
    });
  });

  it("requires a separator between 'thought' and 'signature' — bare 'thoughtsignature' is not a real OpenClaw variant and must not match", () => {
    // Defensive: keep the regex narrow enough that a future provider error
    // mentioning the wrong English word ("a thoughtsignature mismatch" in
    // some other unrelated context, vendor docs string, etc.) cannot hijack
    // this classifier and trigger the upstream-format-error UX for an
    // unrelated bug. Only the two real OpenClaw variants
    // (`thought_signature` snake_case, `thoughtSignature` camelCase) should
    // match — both have a separator (underscore or upper-case S).
    expect(
      classifyUpstreamFormatError(
        "rawError=400 thoughtsignature mismatch detected by linter",
        "ollama-cloud/gemini-3-flash-preview"
      )
    ).toBeNull();
  });

  it("does not collide with classifyModelError (orthogonal classifiers)", () => {
    // The same thought_signature text should classify as upstream_format_error
    // but NOT as model_unavailable — the issue is upstream schema, not server
    // overload, and the wording the user sees has to match the actual cause.
    expect(classifyModelError(PROD_ERROR_TEXT, "ollama-cloud/gemini-3-flash-preview")).toBeNull();
    expect(
      classifyUpstreamFormatError(PROD_ERROR_TEXT, "ollama-cloud/gemini-3-flash-preview")?.kind
    ).toBe("upstream_format_error");
  });
});
