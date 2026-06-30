import { describe, it, expect } from "vitest";
import {
  getErrorHint,
  presentProviderError,
  PROVIDER_SETTINGS_HINT,
  PROVIDER_REJECTED_GENERIC_MESSAGE,
  CONTEXT_OVERFLOW_HINT,
  CONTEXT_OVERFLOW_MESSAGE,
} from "@/server/error-hints";

describe("getErrorHint", () => {
  describe("provider/config errors → role-based hint", () => {
    const providerKeywords = [
      "Your credit balance is too low to access the Anthropic API",
      "Invalid API key provided",
      "authentication failed",
      "Unauthorized: invalid x-api-key",
      "You exceeded your current quota",
      "insufficient_quota",
    ];

    it.each(providerKeywords)("should return admin hint for provider error: %s", (errorText) => {
      const hint = getErrorHint(errorText, "admin");
      expect(hint).toBe(PROVIDER_SETTINGS_HINT);
    });

    it.each(providerKeywords)("should return member hint for provider error: %s", (errorText) => {
      const hint = getErrorHint(errorText, "member");
      expect(hint).toBe("Please contact your administrator.");
    });
  });

  describe("transient errors → try again hint", () => {
    const transientKeywords = [
      "Rate limit exceeded",
      "Too many requests",
      "Request timeout",
      "Request timed out",
      "The model did not produce a response. It may have timed out.",
      "The server is overloaded",
      "529 overloaded",
    ];

    it.each(transientKeywords)(
      "should return try-again hint for transient error: %s",
      (errorText) => {
        expect(getErrorHint(errorText, "admin")).toBe("Try again in a moment.");
        expect(getErrorHint(errorText, "member")).toBe("Try again in a moment.");
      }
    );
  });

  describe("generic OpenClaw provider-rejection envelope → role-based hint (#584)", () => {
    // Ground truth from staging audit (2026-06-24): when a provider rejects a
    // run for an account-side reason (e.g. depleted credit), OpenClaw collapses
    // the cause into this exact generic catch-all and emits it as the error
    // chunk text. The distinguishing reason never reaches Pinchy, so we can't
    // honestly classify it (audit class stays `unknown`) — but we CAN stop
    // showing it bare and point an admin at their provider configuration.
    const genericEnvelope =
      "LLM request failed: provider rejected the request schema or tool payload.";

    it("should return admin hint for the generic provider-rejection envelope", () => {
      expect(getErrorHint(genericEnvelope, "admin")).toBe(PROVIDER_SETTINGS_HINT);
    });

    it("should return member hint for the generic provider-rejection envelope", () => {
      expect(getErrorHint(genericEnvelope, "member")).toBe("Please contact your administrator.");
    });

    it("should match case-insensitively", () => {
      expect(getErrorHint("PROVIDER REJECTED THE REQUEST SCHEMA OR TOOL PAYLOAD", "admin")).toBe(
        PROVIDER_SETTINGS_HINT
      );
    });
  });

  describe("unrecognized errors → null", () => {
    it("should return null for unrecognized errors", () => {
      expect(getErrorHint("Something completely unexpected", "admin")).toBeNull();
      expect(getErrorHint("ECONNREFUSED 127.0.0.1", "member")).toBeNull();
    });
  });

  describe("case insensitivity", () => {
    it("should match keywords case-insensitively", () => {
      expect(getErrorHint("RATE LIMIT EXCEEDED", "admin")).toBe("Try again in a moment.");
      expect(getErrorHint("invalid api key", "admin")).toBe(PROVIDER_SETTINGS_HINT);
    });
  });

  describe("ambiguous keywords — ordering matters", () => {
    it("should classify 'Rate limit exceeded' as transient, not provider (exceeded appears in both)", () => {
      // "exceeded" matches the provider pattern, but "rate limit" is more
      // specific. Transient patterns are checked first to prevent misclassification.
      expect(getErrorHint("Rate limit exceeded", "admin")).toBe("Try again in a moment.");
    });

    it("should classify 'You exceeded your current quota' as provider", () => {
      // "quota" matches the provider pattern. Bare `exceeded` is deliberately
      // NOT in the pattern so e.g. "context window exceeded" doesn't get
      // misrouted to the provider-config admin hint.
      expect(getErrorHint("You exceeded your current quota", "admin")).toBe(PROVIDER_SETTINGS_HINT);
    });

    it("should NOT misroute 'context window exceeded' to the provider-config hint", () => {
      // Context-window overflow is a model-capability/length issue, not a
      // provider-config one — keeping bare `exceeded` out of
      // PROVIDER_CONFIG_PATTERN is what stops the misleading "check your API
      // configuration" hint. It now gets its own actionable hint (#611) instead
      // of falling through to null.
      expect(getErrorHint("context window exceeded for this prompt", "admin")).toBe(
        CONTEXT_OVERFLOW_HINT
      );
      expect(getErrorHint("context window exceeded for this prompt", "member")).toBe(
        CONTEXT_OVERFLOW_HINT
      );
    });
  });

  describe("context-overflow → compact/new-chat hint, not OpenClaw's /reset advice (#611)", () => {
    const overflowTexts = [
      "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
      "context window exceeded for this prompt",
      "The prompt is too large for the model's context length.",
      "Please use a larger-context model.",
    ];

    it.each(overflowTexts)("returns the compact hint (role-independent): %s", (text) => {
      expect(getErrorHint(text, "admin")).toBe(CONTEXT_OVERFLOW_HINT);
      expect(getErrorHint(text, "member")).toBe(CONTEXT_OVERFLOW_HINT);
    });

    it("presentProviderError replaces OpenClaw's /reset advice with a clean message", () => {
      const raw =
        "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
      const shown = presentProviderError(raw);
      expect(shown).toBe(CONTEXT_OVERFLOW_MESSAGE);
      expect(shown).not.toMatch(/\/reset|\/new/);
    });

    it("presentProviderError leaves non-overflow errors unchanged", () => {
      expect(presentProviderError("Invalid API key provided")).toBe("Invalid API key provided");
      expect(presentProviderError("Rate limit exceeded")).toBe("Rate limit exceeded");
    });

    it("presentProviderError rewrites the generic provider-rejection envelope so the banner doesn't read like a malformed-request bug (#584)", () => {
      const raw = "LLM request failed: provider rejected the request schema or tool payload.";
      const shown = presentProviderError(raw);
      expect(shown).toBe(PROVIDER_REJECTED_GENERIC_MESSAGE);
      // The misleading "schema or tool payload" framing must not reach the user.
      expect(shown).not.toMatch(/schema or tool payload/i);
      // It should point at the provider-account cause family.
      expect(shown).toMatch(/billing|quota|api key|provider/i);
    });

    it("presentProviderError does NOT rewrite the thought_signature payload's envelope (schema_rejection keeps its own wording) (#584)", () => {
      // The Gemini-3 schema-rejection text carries the generic envelope plus a
      // thought_signature. Its own branch (classifyUpstreamFormatError) handles
      // the user-facing wording; presentProviderError must not collapse it into
      // the generic-account message. The raw envelope text passes through here.
      const raw =
        "LLM request failed: provider rejected the request schema or tool payload. " +
        'rawError=400 "Function call is missing a thought_signature in functionCall parts."';
      // The thought_signature payload is not context-overflow and not the bare
      // generic envelope (it has extra content), so it passes through unchanged.
      expect(presentProviderError(raw)).toBe(raw);
    });
  });
});
