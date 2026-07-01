import { describe, it, expect } from "vitest";
import {
  getErrorHint,
  presentProviderError,
  PROVIDER_SETTINGS_HINT,
  CONTEXT_OVERFLOW_HINT,
  CONTEXT_OVERFLOW_MESSAGE,
  MODEL_RETIRED_MESSAGE,
  MODEL_RETIRED_HINT_ADMIN,
  MODEL_RETIRED_HINT_MEMBER,
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
  });

  describe("retired model → names the model, admin/member hint, no unproven cause elsewhere", () => {
    // Real staging incident (2026-07-01): an agent pinned to
    // ollama-cloud/qwen3-vl:235b-instruct (retired by Ollama Cloud on 2026-06-16)
    // failed every turn. OpenClaw's OWN container log split the detail cleanly
    // (`error=LLM request failed. rawError=410 {"error":"...was retired..."}`),
    // but only the generic `error` half crosses the gateway RPC to Pinchy — the
    // `rawError` detail never reaches `chunk.text` (see error-patterns.ts's
    // PROVIDER_REJECTED_GENERIC_PATTERN note for the same upstream-collapsing
    // limitation, #584/openclaw#93741). A retirement text WITH a surviving
    // token (410/retired/unknown model/etc.) still gets the specific message
    // below when one happens to survive (e.g. a different error source, per
    // model-retirement.test.ts's PDF-model-resolution example, which DOES get
    // the full body via a direct HTTP call rather than the collapsed WS RPC).
    const retirementTexts = [
      '410 "qwen3-vl:235b-instruct was retired at 2026-06-16 00:00:00 -0700 PDT"',
      "Unknown model: ollama-cloud/gemini-2-preview-0514",
      "model_not_found",
      "the model was retired",
    ];

    it.each(retirementTexts)("presentProviderError names the model: %s", (text) => {
      const shown = presentProviderError(text, "ollama-cloud/qwen3-vl:235b-instruct");
      expect(shown).toBe(MODEL_RETIRED_MESSAGE("ollama-cloud/qwen3-vl:235b-instruct"));
      expect(shown).toContain("ollama-cloud/qwen3-vl:235b-instruct");
      expect(shown).not.toBe(text);
    });

    it("presentProviderError falls back to a generic (no-name) message when no model name is known", () => {
      expect(presentProviderError(retirementTexts[0]!)).toBe(MODEL_RETIRED_MESSAGE(undefined));
      expect(presentProviderError(retirementTexts[0]!)).not.toContain("qwen3-vl");
    });

    it.each(retirementTexts)("getErrorHint returns the admin/member hint: %s", (text) => {
      expect(getErrorHint(text, "admin")).toBe(MODEL_RETIRED_HINT_ADMIN);
      expect(getErrorHint(text, "member")).toBe(MODEL_RETIRED_HINT_MEMBER);
    });

    it("does not misroute a bare '410' into transient/provider-config/overflow", () => {
      // A bare 410 is deliberately broad (mirrors model-retirement.ts's own
      // RETIREMENT_PATTERNS reasoning) but must not collide with the other
      // specific patterns (529/rate-limit for transient, credit/key/quota for
      // provider-config, context/tokens for overflow) — none of them mention 410.
      expect(getErrorHint("410", "admin")).toBe(MODEL_RETIRED_HINT_ADMIN);
    });
  });

  describe("generic unclassified error → names the model without asserting a cause (#611 follow-up)", () => {
    // The ACTUAL staging incident's stored providerError was the bare OpenClaw
    // fallback string with ZERO retirement signal — ground truth, verified via
    // `select provider_error from chat_session_errors` on staging (2026-07-01):
    // `"LLM request failed."`. matchesRetirement (and every other pattern) can't
    // fire on this — there is nothing to pattern-match. This is the actual fix
    // for the reported bug: Pinchy already knows WHICH model it dispatched to
    // regardless of why the dispatch failed, so naming it turns a fully opaque
    // message into something actionable without asserting an unproven cause
    // (the honest constraint that already shapes PROVIDER_REJECTED_GENERIC_PATTERN).
    const bareFallback = "LLM request failed.";

    it("appends the model name to an otherwise-unclassified error", () => {
      expect(presentProviderError(bareFallback, "ollama-cloud/qwen3-vl:235b-instruct")).toBe(
        "LLM request failed. (model: ollama-cloud/qwen3-vl:235b-instruct)"
      );
    });

    it("leaves the text unchanged when no model name is known", () => {
      expect(presentProviderError(bareFallback)).toBe(bareFallback);
    });

    it("does not append a model name to a fully-replaced message (overflow/retirement)", () => {
      const overflow = presentProviderError(
        "context window exceeded for this prompt",
        "some-model"
      );
      expect(overflow).toBe(CONTEXT_OVERFLOW_MESSAGE);
      expect(overflow).not.toContain("some-model");
    });

    it("getErrorHint stays null for the unclassified bucket (unchanged pre-existing behavior)", () => {
      expect(getErrorHint(bareFallback, "admin")).toBeNull();
    });
  });
});
