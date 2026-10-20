import { describe, it, expect } from "vitest";
import { selectDefaultModel, BALANCED_PATTERNS } from "@/lib/provider-models";
import { BALANCED_ANCHORS } from "@/lib/provider-model-constants";
import { getModelCatalogForProvider } from "@/lib/openclaw-builtin-models";

const ids = (provider: string, models: string[]) =>
  models.map((id) => ({ id: `${provider}/${id}`, name: id }));

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

  // The winners here are deliberately NOT curated models: a curated one wins
  // through the curated-first rule regardless, and the case would pass without
  // the variant filters ever being consulted.
  describe("rejected variants never win", () => {
    it.each([
      ["anthropic", "anthropic/claude-sonnet-6-0-preview", "anthropic/claude-sonnet-5-9"],
      ["anthropic", "anthropic/claude-sonnet-6-0-beta", "anthropic/claude-sonnet-5-9"],
      ["openai", "openai/gpt-7-thinking", "openai/gpt-6.9"],
      ["openai", "openai/gpt-7-instant", "openai/gpt-6.9"],
      ["openai", "openai/gpt-7-nano", "openai/gpt-6.9"],
      ["google", "google/gemini-4-pro-exp", "google/gemini-3.9-pro"],
    ] as const)("%s: %s does not beat %s", (provider, rejected, expected) => {
      const models = [
        { id: rejected, name: "x" },
        { id: expected, name: "x" },
      ];
      expect(selectDefaultModel(provider, models)).toBe(expected);
    });
  });

  describe("lexicographic tiebreaker when dates equal", () => {
    it("anthropic: sonnet-6-1 beats sonnet-6-0 when neither has date suffix", () => {
      const models = [
        { id: "anthropic/claude-sonnet-6-0", name: "x" },
        { id: "anthropic/claude-sonnet-6-1", name: "x" },
      ];
      expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-sonnet-6-1");
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
      ["anthropic", "anthropic/claude-sonnet-5"],
      ["openai", "openai/gpt-5.5"],
      ["google", "google/gemini-2.5-pro"],
      ["ollama-cloud", "ollama-cloud/kimi-k2.6"],
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
      // gpt-6.9 is not curated, so only the variant filters can keep it ahead.
      const id = `openai/gpt-7-${suffix}`;
      const models = [
        { id, name: "x" },
        { id: "openai/gpt-6.9", name: "x" },
      ];
      expect(selectDefaultModel("openai", models)).toBe("openai/gpt-6.9");
    });
  });
});

// The balanced default feeds the pdf/image vision chain and the knowledge-base
// OCR, and both gate on the capability table — which is seeded from the curated
// catalog only. A default the catalog does not declare reads as "no vision", so
// the provider silently drops out of the chain: on an Anthropic-only install
// that meant no pdf tool and every scanned document indexed as empty.
describe("balanced default — curated models first", () => {
  // Shape of GET /v1/models on an Anthropic key in October 2026: dated ids are
  // the OLDER snapshots (dateless ids start with the 4.6 generation), so the
  // date-first ordering below would otherwise pick the oldest Sonnet listed.
  const ANTHROPIC_LIVE = ids("anthropic", [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
  ]);
  const OPENAI_LIVE = ids("openai", [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.5-2026-04-23",
    "gpt-5.4",
    "gpt-5.4-mini",
  ]);
  const GOOGLE_LIVE = ids("google", [
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ]);

  it.each([
    ["anthropic", "anthropic/claude-sonnet-5", ANTHROPIC_LIVE],
    ["openai", "openai/gpt-5.5", OPENAI_LIVE],
    ["google", "google/gemini-2.5-pro", GOOGLE_LIVE],
  ] as const)("%s: a real live catalog resolves to %s", (provider, expected, live) => {
    expect(selectDefaultModel(provider, [...live])).toBe(expected);
  });

  it.each(["anthropic", "openai", "google"] as const)(
    "%s: with every curated model live, the default is BALANCED_ANCHORS",
    (provider) => {
      const curated = getModelCatalogForProvider(provider).map((m) => ({
        id: `${provider}/${m.id}`,
        name: m.name,
      }));
      expect(selectDefaultModel(provider, curated)).toBe(BALANCED_ANCHORS[provider]);
    }
  );

  it("anthropic: a curated Sonnet beats a newer one Pinchy has no definition for", () => {
    const models = ids("anthropic", ["claude-sonnet-5-5", "claude-sonnet-5"]);
    expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-sonnet-5");
  });

  // The uncurated fallback still never lands on a model the tools-blocklist
  // names: every agent drives tools, so that default could not run one.
  it("anthropic: with no curated Sonnet live, the fallback skips tools-blocked models", () => {
    // Both dateless, so ordering alone would put the blocked 5-5 first.
    const models = ids("anthropic", ["claude-sonnet-5-5", "claude-sonnet-4-5"]);
    expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-sonnet-4-5");
  });
});
