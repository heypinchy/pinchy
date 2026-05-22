import { describe, it, expect } from "vitest";
import { getErrorHint, PROVIDER_SETTINGS_HINT } from "@/server/error-hints";

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

    it("should return null for 'context window exceeded' (model capability, not config)", () => {
      // Context-window overflow is a model-capability issue: the user should
      // swap to a larger-context model or trim the input. Telling them to
      // "check your API configuration" would be misleading. Keeping bare
      // `exceeded` out of PROVIDER_CONFIG_PATTERN is what makes this fall
      // through to `null` (no hint) instead.
      expect(getErrorHint("context window exceeded for this prompt", "admin")).toBeNull();
      expect(getErrorHint("context window exceeded for this prompt", "member")).toBeNull();
    });
  });
});
