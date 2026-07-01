import { describe, it, expect } from "vitest";
import {
  classifyAgentError,
  classifySynthesisedError,
  classifyTransientReason,
  shouldPersistDurableError,
  type AgentErrorClass,
} from "@/server/agent-error-classifier";

describe("classifyTransientReason", () => {
  it("names a rate limit as rate_limit", () => {
    expect(classifyTransientReason("⚠️ API rate limit reached")).toBe("rate_limit");
    expect(classifyTransientReason("Too many requests")).toBe("rate_limit");
  });

  it("names overloaded / HTTP 529 as overloaded", () => {
    expect(classifyTransientReason("The model is overloaded")).toBe("overloaded");
    expect(classifyTransientReason("HTTP 529 from upstream")).toBe("overloaded");
  });

  it("names a timeout as timeout", () => {
    expect(classifyTransientReason("the request timed out")).toBe("timeout");
  });

  it("falls back to unavailable rather than guessing 'rate limit' for unknown transient text", () => {
    expect(classifyTransientReason("temporary upstream blip")).toBe("unavailable");
  });
});

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

  it("does not classify 'context window exceeded' as provider_config", () => {
    // `exceeded` alone is too broad — "context window exceeded" is a
    // model-capability issue (input too large for the model), not a
    // configuration issue. Misclassifying it would route the admin hint to
    // "check your API configuration" which is the wrong fix. The user
    // should swap to a larger-context model, not touch their API key.
    //
    // The remaining `*_exceeded` cases we DO want to catch are covered by
    // their specific keywords: `quota exceeded` matches via `quota`,
    // `rate limit exceeded` matches via `rate limit` in TRANSIENT_PATTERN.
    expect(classifyAgentError("context window exceeded for this prompt")).toBe("unknown");
  });

  it("still classifies 'quota exceeded' as provider_config via the 'quota' keyword", () => {
    // Regression guard: dropping bare `exceeded` from the regex must not
    // regress the quota-exhaustion path, which is the canonical
    // provider-config failure shape.
    expect(classifyAgentError("You exceeded your current quota for the month")).toBe(
      "provider_config"
    );
  });
});

describe("shouldPersistDurableError", () => {
  // The durable "paused" banner (chat_session_errors) exists to re-surface an
  // error a user might have MISSED — a one-off/intermittent failure whose live
  // bubble died on a reload/reconnect. For a PERSISTENT problem (a retired
  // model, an over-large prompt, a bad provider config) the next attempt fails
  // the same way, so the error can't be missed and a sticky, reappearing banner
  // is pure annoyance. So we only persist the retryable/intermittent classes.

  const durableClasses: AgentErrorClass[] = [
    "transient",
    "silent_stream_timeout",
    "model_unavailable",
    "schema_rejection",
    "failover_incomplete_stream",
  ];
  const nonDurableClasses: AgentErrorClass[] = ["provider_config", "unknown"];

  it.each(durableClasses)("persists a durable banner for retryable class: %s", (cls) => {
    expect(shouldPersistDurableError(cls)).toBe(true);
  });

  it.each(nonDurableClasses)(
    "does NOT persist a durable banner for persistent class: %s (shows inline only)",
    (cls) => {
      expect(shouldPersistDurableError(cls)).toBe(false);
    }
  );

  it("keeps a retired model (unknown class) OUT of the durable banner", () => {
    // The reported staging bug: an agent pinned to a retired model 410s every
    // turn; its providerError collapses to the bare "LLM request failed." which
    // classifies as `unknown`. Retry can't help until an admin changes the
    // model, so it must not create a sticky durable banner.
    expect(shouldPersistDurableError(classifyAgentError("LLM request failed."))).toBe(false);
  });
});

describe("classifySynthesisedError", () => {
  // For error frames Pinchy synthesises itself (no upstream provider text to
  // pattern-match against), call sites pass the synthesised reason and get
  // back the corresponding stable audit label. The TypeScript signature is
  // an exhaustive `SynthesisedErrorReason` union so adding a new synthesised-
  // error site in the future is a compile error here, not a silent gap in
  // the audit umbrella.

  it("maps the silent-stream reason to the silent_stream_timeout audit class", () => {
    expect(classifySynthesisedError("silent_stream")).toBe("silent_stream_timeout");
  });

  it("returns a value typed as AgentErrorClass (compile-time contract)", () => {
    // Compile-time guard: the return value must be assignable to AgentErrorClass.
    // If someone changes the helper to return a wider string type, this stops
    // compiling, which prevents the audit detail from drifting away from the
    // declared union.
    const cls: import("@/server/agent-error-classifier").AgentErrorClass =
      classifySynthesisedError("silent_stream");
    expect(cls).toBe("silent_stream_timeout");
  });
});
