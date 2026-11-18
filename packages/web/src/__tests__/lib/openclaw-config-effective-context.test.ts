import { describe, it, expect } from "vitest";
import {
  MAX_EFFECTIVE_CONTEXT_TOKENS,
  applyEffectiveContextCeiling,
} from "@/lib/openclaw-config/effective-context";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS, type OllamaCloudModel } from "@/lib/ollama-cloud-models";

// The 2026-07-24 Piper incident: glm-5.2 (999,424 window, no per-model cap) ran a
// session to ~633K input tokens with compactionCount:0, because OpenClaw's
// shouldCompact() fires at `(contextTokens ?? contextWindow) − 16384` — i.e.
// 983,040 for glm-5.2, never in practice. The per-model deepseek-v4-pro cap
// (2026-07-16) did not generalize. This ceiling bounds the *effective* runtime
// context of EVERY emitted model — every provider, current and future — so
// native compaction always has a reachable trigger. It is an operational bound
// (worst-case turn latency + cache-miss cost), distinct from the per-model
// quality knee that lives in the model catalog.

/** Minimal stand-in for one emitted `models.providers.<name>` entry. */
function provider(models: Array<Record<string, unknown>>) {
  return { baseUrl: "https://example.test/v1", models };
}

describe("MAX_EFFECTIVE_CONTEXT_TOKENS", () => {
  it("anchors the ceiling to 256K — the largest window that already compacts healthily in prod (kimi-k2.6)", () => {
    expect(MAX_EFFECTIVE_CONTEXT_TOKENS).toBe(262144);
  });
});

describe("applyEffectiveContextCeiling", () => {
  it("caps a large-window model with no per-model knee at the ceiling", () => {
    // The incident shape: glm-5.2's 999,424 window put shouldCompact()'s trigger
    // at 983,040, i.e. out of reach. Now it is 262,144 − 16,384 = 245,760.
    const providers = {
      "ollama-cloud": provider([{ id: "glm-5.2", contextWindow: 999424 }]),
    };

    applyEffectiveContextCeiling(providers);

    expect(providers["ollama-cloud"].models[0].contextTokens).toBe(262144);
    // The advertised native window stays honest — only the budget is bounded.
    expect(providers["ollama-cloud"].models[0].contextWindow).toBe(999424);
  });

  it("preserves a lower per-model quality knee instead of raising it to the ceiling", () => {
    // min(131072, 262144) = 131072. The clamp only ever lowers.
    const providers = {
      "ollama-cloud": provider([
        { id: "deepseek-v4-pro", contextWindow: 524288, contextTokens: 131072 },
      ]),
    };

    applyEffectiveContextCeiling(providers);

    expect(providers["ollama-cloud"].models[0].contextTokens).toBe(131072);
  });

  it("is a no-op in effect for models whose window is at or below the ceiling", () => {
    // contextTokens == contextWindow, so compaction behaves exactly as before
    // (kimi-k2.6 already compacts healthily at 262,144).
    const providers = {
      "ollama-cloud": provider([
        { id: "kimi-k2.6", contextWindow: 262144 },
        { id: "glm-5.1", contextWindow: 202752 },
      ]),
    };

    applyEffectiveContextCeiling(providers);

    expect(providers["ollama-cloud"].models[0].contextTokens).toBe(262144);
    expect(providers["ollama-cloud"].models[1].contextTokens).toBe(202752);
  });

  it("covers EVERY provider in the tree, not just the one that caused the incident", () => {
    // The load-bearing assertion. Pinchy emits models from four independent
    // paths; three shipped uncapped windows before this clamp existed —
    // built-in Gemini alone advertises 1,048,576, the same shape as glm-5.2.
    // Capping per call site would repeat the whack-a-mole that let the incident
    // happen after deepseek-v4-pro was already capped.
    const providers = {
      google: provider([{ id: "gemini-2.5-pro", contextWindow: 1048576 }]),
      anthropic: provider([{ id: "claude-sonnet-5", contextWindow: 200000 }]),
      ollama: provider([{ id: "qwen3:8b", contextWindow: 1048576 }]),
      "my-custom-endpoint": provider([{ id: "some-model", contextWindow: 700000 }]),
    };

    applyEffectiveContextCeiling(providers);

    expect(providers.google.models[0].contextTokens).toBe(262144);
    expect(providers.ollama.models[0].contextTokens).toBe(262144);
    expect(providers["my-custom-endpoint"].models[0].contextTokens).toBe(262144);
    // Under the ceiling → unchanged budget.
    expect(providers.anthropic.models[0].contextTokens).toBe(200000);
  });

  it("leaves a model with no numeric contextWindow untouched", () => {
    // Without a window there is no honest budget to derive; inventing one could
    // claim MORE context than the model supports. OpenClaw resolves those from
    // its own catalog instead.
    const providers = { custom: provider([{ id: "unknown-model" }]) };

    applyEffectiveContextCeiling(providers);

    expect(providers.custom.models[0].contextTokens).toBeUndefined();
  });

  it("tolerates providers that carry no models array", () => {
    // Not every emitted provider entry has a model list (and the tree is typed
    // as Record<string, unknown> at the call site), so the clamp must not throw.
    const providers = { weird: { baseUrl: "https://example.test/v1" }, nope: null };

    expect(() => applyEffectiveContextCeiling(providers)).not.toThrow();
  });

  it("never budgets above the native window, even when a knee exceeds it", () => {
    // The clamp now covers three UNCURATED emission paths (live OpenAI-compatible
    // discovery, local Ollama /api/show, admin snapshots), so it cannot lean on
    // the curated catalog's "contextTokens <= contextWindow" test. A knee above
    // the window would otherwise survive as long as it stayed under the ceiling —
    // claiming MORE context than the model actually has, which is the one thing
    // the windowless-model skip below already refuses to do.
    const providers = {
      custom: provider([{ id: "mis-declared", contextWindow: 200000, contextTokens: 300000 }]),
    };

    applyEffectiveContextCeiling(providers);

    expect(providers.custom.models[0].contextTokens).toBe(200000);
  });

  it("returns the same tree, so the clamp can be inlined into the config assignment", () => {
    // build.ts assigns `models: { providers: applyEffectiveContextCeiling(...) }`
    // rather than calling the clamp as a free statement. That is what makes the
    // choke point ordering-proof: a future `modelProviders["fifth-path"] = …`
    // inserted below the old call site would have escaped silently — the exact
    // whack-a-mole failure this module exists to end.
    const providers = { custom: provider([{ id: "m", contextWindow: 999424 }]) };

    expect(applyEffectiveContextCeiling(providers)).toBe(providers);
  });

  it("never lets any curated ollama-cloud model exceed the ceiling or its own window", () => {
    // Run the real catalog through the clamp — the invariant that actually ships.
    const catalog: readonly OllamaCloudModel[] = TOOL_CAPABLE_OLLAMA_CLOUD_MODELS;
    const providers = {
      "ollama-cloud": provider(
        catalog.map((m) => ({
          id: m.id,
          contextWindow: m.contextWindow,
          ...(m.contextTokens !== undefined ? { contextTokens: m.contextTokens } : {}),
        }))
      ),
    };

    applyEffectiveContextCeiling(providers);

    for (const m of providers["ollama-cloud"].models) {
      const tokens = m.contextTokens as number;
      expect(tokens).toBeLessThanOrEqual(MAX_EFFECTIVE_CONTEXT_TOKENS);
      expect(tokens).toBeLessThanOrEqual(m.contextWindow as number);
    }
  });
});
