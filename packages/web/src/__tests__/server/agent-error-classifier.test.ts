import { describe, it, expect } from "vitest";
import { classifyAgentError } from "@/server/agent-error-classifier";

describe("classifyAgentError", () => {
  it("classifies the production FailoverError with incomplete terminal response (issue #355)", () => {
    // Verbatim payload from the first tracking entry in heypinchy/pinchy#355.
    // OpenClaw raises this when an upstream stream closes cleanly at TCP level
    // but without a finish_reason / message_stop / SSE [DONE] terminal token,
    // i.e. truncated response. Failover machinery is exhausted so the user sees
    // the error directly instead of being routed to a fallback model.
    const result = classifyAgentError(
      "FailoverError: ollama-cloud/gemini-3-flash-preview ended with an incomplete terminal response"
    );
    expect(result).toBe("failover_incomplete_stream");
  });

  it("classifies the production Gemini-3 thought_signature schema rejection (issue #338 / #355)", () => {
    // Verbatim production payload — the Penny tracking entry from #355.
    // Different shape than classifyUpstreamFormatError's input (which gets
    // model context too): here we classify from the raw error text alone, so
    // the audit umbrella sees the same outcome regardless of model context.
    const result = classifyAgentError(
      "LLM request failed: provider rejected the request schema or tool payload. " +
        'rawError=400 "Function call is missing a thought_signature in functionCall parts. ' +
        '(ref: 3d5cf450-a3f6-4566-a1db-a7c5c0515cc0)"'
    );
    expect(result).toBe("schema_rejection");
  });

  it("classifies the camelCase thoughtSignature variant as schema_rejection", () => {
    // The OpenAI-compat replay path used by ollama-cloud emits camelCase;
    // the native Google path emits snake_case. Both reach Pinchy.
    const result = classifyAgentError(
      "Function call is missing a thoughtSignature in functionCall parts."
    );
    expect(result).toBe("schema_rejection");
  });

  it.each([500, 502, 503, 504])("classifies HTTP %i as model_unavailable", (status) => {
    expect(classifyAgentError(`HTTP ${status}: upstream error`)).toBe("model_unavailable");
  });

  it.each([
    ["rate limit exceeded for provider"],
    ["Too Many Requests"],
    ["request timed out"],
    ["Server overloaded, please retry"],
    ["HTTP 529: Anthropic overloaded"],
  ])("classifies %s as transient", (text) => {
    expect(classifyAgentError(text)).toBe("transient");
  });

  it.each([
    ["api key invalid"],
    ["credit balance too low"],
    ["unauthorized: missing API key"],
    ["quota exceeded for this model"],
  ])("classifies %s as provider_config", (text) => {
    expect(classifyAgentError(text)).toBe("provider_config");
  });

  it("returns unknown for unrecognised strings", () => {
    expect(classifyAgentError("some weird unprecedented thing happened")).toBe("unknown");
    expect(classifyAgentError("")).toBe("unknown");
  });

  it("classifies transient before provider_config when text mentions 'exceeded'", () => {
    // Defensive: `rate limit exceeded` contains "exceeded" which would also
    // match the provider-config family. Mirrors the same precedence rule
    // already present in error-hints.ts. Otherwise users hitting their model
    // rate limit would be told to check their API configuration.
    expect(classifyAgentError("Rate limit exceeded — try again in 30s")).toBe("transient");
  });

  it("does not match bare-word 'thoughtsignature' without separator (defensive)", () => {
    // Same defensive rule as classifyUpstreamFormatError in
    // model-error-classifier.ts — keep the regex narrow enough that an
    // unrelated future provider error mentioning the wrong English word
    // cannot hijack the schema_rejection branch.
    expect(classifyAgentError("thoughtsignature mismatch detected by linter")).toBe("unknown");
  });
});
