import { describe, it, expect } from "vitest";
import { selectDefaultModel, BALANCED_PATTERNS } from "@/lib/provider-models";
import { BALANCED_ANCHORS } from "@/lib/provider-model-constants";

describe("balanced default — drift resistance", () => {
  describe("new date-suffix models win", () => {
    it("anthropic: claude-sonnet-5-0-20260601 beats claude-sonnet-4-6-20251001", () => {
      const models = [
        { id: "anthropic/claude-sonnet-4-6-20251001", name: "x" },
        { id: "anthropic/claude-sonnet-5-0-20260601", name: "x" },
      ];
      expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-sonnet-5-0-20260601");
    });

    it("openai: gpt-6-2026-06-01 beats gpt-5.5-2025-08-07", () => {
      const models = [
        { id: "openai/gpt-5.5-2025-08-07", name: "x" },
        { id: "openai/gpt-6-2026-06-01", name: "x" },
      ];
      expect(selectDefaultModel("openai", models)).toBe("openai/gpt-6-2026-06-01");
    });
  });

  describe("rejected variants never win", () => {
    it.each([
      ["anthropic", "anthropic/claude-sonnet-5-0-preview", "anthropic/claude-sonnet-4-6"],
      ["anthropic", "anthropic/claude-sonnet-5-0-beta", "anthropic/claude-sonnet-4-6"],
      ["openai", "openai/gpt-6-thinking", "openai/gpt-5.5"],
      ["openai", "openai/gpt-6-instant", "openai/gpt-5.5"],
      ["openai", "openai/gpt-6-nano", "openai/gpt-5.5"],
      ["google", "google/gemini-3-pro-exp", "google/gemini-2.5-pro"],
    ] as const)("%s: %s does not beat %s", (provider, rejected, expected) => {
      const models = [
        { id: rejected, name: "x" },
        { id: expected, name: "x" },
      ];
      expect(selectDefaultModel(provider, models)).toBe(expected);
    });
  });

  describe("lexicographic tiebreaker when dates equal", () => {
    it("anthropic: sonnet-5-0 beats sonnet-4-6 when neither has date suffix", () => {
      const models = [
        { id: "anthropic/claude-sonnet-4-6", name: "x" },
        { id: "anthropic/claude-sonnet-5-0", name: "x" },
      ];
      expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-sonnet-5-0");
    });

    it("google: gemini-3-pro-002 beats gemini-2.5-pro-002", () => {
      const models = [
        { id: "google/gemini-2.5-pro-002", name: "x" },
        { id: "google/gemini-3-pro-002", name: "x" },
      ];
      expect(selectDefaultModel("google", models)).toBe("google/gemini-3-pro-002");
    });
  });

  describe("regression — gpt-4o-mini bug", () => {
    it("OpenAI: gpt-5.5 wins over gpt-4o-mini even when both appear in candidates", () => {
      const models = [
        { id: "openai/gpt-4o-mini", name: "x" },
        { id: "openai/gpt-4o-mini-2024-07-18", name: "x" },
        { id: "openai/gpt-5.5", name: "x" },
      ];
      expect(selectDefaultModel("openai", models)).toBe("openai/gpt-5.5");
    });
  });

  describe("anchor fallback when no pattern match", () => {
    it.each([
      ["anthropic", "anthropic/claude-sonnet-4-6"],
      ["openai", "openai/gpt-5.5"],
      ["google", "google/gemini-2.5-pro"],
      ["ollama-cloud", "ollama-cloud/glm-4.7"],
    ] as const)("%s: empty candidate list → anchor %s", (provider, anchor) => {
      const noMatch = [{ id: `${provider}/something-totally-unexpected`, name: "x" }];
      expect(selectDefaultModel(provider, noMatch)).toBe(anchor);
    });
  });

  describe("BALANCED_ANCHORS match their own BALANCED_PATTERNS", () => {
    // If an anchor doesn't match its provider's pattern, the anchor would
    // never be selected from a live model list — only from the fallback
    // branch. That makes the anchor a silent dead letter rather than the
    // canonical balanced default. Lock the invariant down.
    it.each([["anthropic"], ["openai"], ["google"], ["ollama-cloud"]] as const)(
      "%s: anchor passes its own pattern",
      (provider) => {
        const anchor = BALANCED_ANCHORS[provider];
        expect(BALANCED_PATTERNS[provider].test(anchor)).toBe(true);
      }
    );
  });

  describe("REJECT_PATTERN coverage", () => {
    const requiredSuffixes = [
      "preview",
      "beta",
      "alpha",
      "rc",
      "exp",
      "experimental",
      "thinking",
      "instant",
      "nano",
      "search",
      "realtime",
      "audio",
      "vision-only",
    ];
    it.each(requiredSuffixes)("rejects -%s suffix", (suffix) => {
      const id = `openai/gpt-6-${suffix}`;
      const models = [
        { id, name: "x" },
        { id: "openai/gpt-5.5", name: "x" },
      ];
      expect(selectDefaultModel("openai", models)).toBe("openai/gpt-5.5");
    });
  });
});
