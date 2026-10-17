import { describe, it, expect } from "vitest";
import { getModelCatalogForProvider } from "@/lib/openclaw-builtin-models";
import snapshot from "@/lib/model-catalog-snapshot.json";

const BUILT_IN_PROVIDERS = ["anthropic", "openai", "google"] as const;

function idsOf(provider: (typeof BUILT_IN_PROVIDERS)[number]): string[] {
  return getModelCatalogForProvider(provider).map((m) => m.id);
}

describe("getModelCatalogForProvider", () => {
  it("returns anthropic models with required OpenClaw ModelDefinitionConfig shape", () => {
    const models = getModelCatalogForProvider("anthropic");
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.name).toBe("string");
      expect(typeof m.contextWindow).toBe("number");
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(typeof m.maxTokens).toBe("number");
      expect(m.maxTokens).toBeGreaterThan(0);
      expect(typeof m.reasoning).toBe("boolean");
      expect(Array.isArray(m.input)).toBe(true);
      expect(m.input.length).toBeGreaterThan(0);
      expect(typeof m.cost).toBe("object");
      expect(typeof m.cost.input).toBe("number");
      expect(typeof m.cost.output).toBe("number");
    }
  });

  it("includes claude-haiku as the default anthropic model", () => {
    const models = getModelCatalogForProvider("anthropic");
    const ids = models.map((m) => m.id);
    expect(ids.some((id) => id.includes("haiku"))).toBe(true);
  });

  it("returns openai models with required shape", () => {
    const models = getModelCatalogForProvider("openai");
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.contextWindow).toBe("number");
      expect(Array.isArray(m.input)).toBe(true);
    }
  });

  it("returns google models with required shape", () => {
    const models = getModelCatalogForProvider("google");
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.contextWindow).toBe("number");
      expect(Array.isArray(m.input)).toBe(true);
    }
  });

  it("model IDs do NOT carry the provider prefix (OpenClaw adds it from the key)", () => {
    const anthropicModels = getModelCatalogForProvider("anthropic");
    for (const m of anthropicModels) {
      expect(m.id).not.toMatch(/^anthropic\//);
    }
    const openaiModels = getModelCatalogForProvider("openai");
    for (const m of openaiModels) {
      expect(m.id).not.toMatch(/^openai\//);
    }
    const googleModels = getModelCatalogForProvider("google");
    for (const m of googleModels) {
      expect(m.id).not.toMatch(/^google\//);
    }
  });

  it("anthropic models declare vision=true", () => {
    for (const m of getModelCatalogForProvider("anthropic")) {
      expect(m.vision).toBe(true);
    }
  });

  it("google models declare vision=true", () => {
    for (const m of getModelCatalogForProvider("google")) {
      expect(m.vision).toBe(true);
    }
  });

  it("openai models declare vision=true", () => {
    for (const m of getModelCatalogForProvider("openai")) {
      expect(m.vision).toBe(true);
    }
  });

  it("built-in models carry no dead capability fields (documents/audio/video)", () => {
    for (const provider of ["anthropic", "openai", "google"] as const) {
      for (const m of getModelCatalogForProvider(provider)) {
        expect("documents" in m).toBe(false);
        expect("audio" in m).toBe(false);
        expect("video" in m).toBe(false);
      }
    }
  });

  // OpenClaw's per-agent model-catalog schema (openclaw-plugin-model-catalog-v1)
  // REQUIRES cost.cacheRead and cost.cacheWrite on every model. A provider whose
  // catalog omits them fails schema validation, and OpenClaw then drops the WHOLE
  // provider from that agent's effective catalog — which silently kills any tool
  // that resolves a model from it (the built-in `pdf`/vision tool defaults to
  // openai/gpt-5.5). On staging this manifested as `pdf failed: Unknown model:
  // openai/gpt-5.5`, so invoice PDFs were never read and the agent booked an
  // unverified lump sum while reporting success. anthropic already declared both
  // fields; openai/google did not. This guard pins every emitted model to the
  // schema so the omission can't recur for a new provider or model.
  it("every built-in model declares numeric cost.cacheRead and cost.cacheWrite (OpenClaw catalog schema)", () => {
    for (const provider of ["anthropic", "openai", "google"] as const) {
      const models = getModelCatalogForProvider(provider);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(typeof m.cost.cacheRead, `${provider}/${m.id} cost.cacheRead`).toBe("number");
        expect(typeof m.cost.cacheWrite, `${provider}/${m.id} cost.cacheWrite`).toBe("number");
      }
    }
  });
});

// This catalog is the ONLY place a built-in provider's model reaches OpenClaw
// (build.ts emits it as models.providers.<name>.models) and the only source of
// the capability rows (vision/tools/long-context) Pinchy decides with. A model
// the provider serves but this list omits is therefore half-supported: it shows
// up in the agent model picker (that list is live), but Pinchy treats it as
// "not vision-capable" and OpenClaw falls back to guessing its limits.
describe("current model generations", () => {
  it("anthropic carries Claude Sonnet 5", () => {
    expect(idsOf("anthropic")).toContain("claude-sonnet-5");
  });

  // Not yet: the pinned OpenClaw (2026.7.1) predates their request contract, so
  // declaring them would hand the runtime models it sends rejected requests
  // for. They are tools-blocked instead (model-resolver/blocklist.ts) and come
  // into this catalog with the OpenClaw update.
  it("does not carry the Claude 5.5 family or Fable 5.1 yet", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ]) {
      expect(idsOf("anthropic")).not.toContain(id);
    }
  });

  // Models existing agents are pinned to stay declared: dropping one would take
  // its definition out of openclaw.json and its row out of the capability table
  // (seedBuiltinModels deletes builtin rows the catalog no longer lists).
  it("keeps the previously curated models for agents already pinned to them", () => {
    expect(idsOf("anthropic")).toEqual(
      expect.arrayContaining(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"])
    );
    expect(idsOf("openai")).toEqual(expect.arrayContaining(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]));
    expect(idsOf("google")).toEqual(
      expect.arrayContaining(["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"])
    );
  });

  // maxTokens is sent as every request's max_tokens, and Anthropic reserves
  // that much of the output-tokens-per-minute limit up front. A 128K
  // reservation can exceed a new low-tier account's whole limit, so each turn
  // would 429 regardless of how short the reply is.
  it("no Anthropic model asks for more than 32K output tokens per request", () => {
    for (const m of getModelCatalogForProvider("anthropic")) {
      expect(m.maxTokens, m.id).toBeLessThanOrEqual(32000);
    }
  });

  // Anthropic publishes separate cache tiers, so this catalog carries them
  // (openai/google stay at 0 — see the comment in openclaw-builtin-models.ts).
  // Source: platform.claude.com/docs/en/about-claude/pricing, read 2026-10-16.
  it.each([
    ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
    ["claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
    ["claude-haiku-4-5-20251001", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ])("anthropic/%s carries the published list price", (id, cost) => {
    const model = getModelCatalogForProvider("anthropic").find((m) => m.id === id);
    expect(model?.cost).toEqual(cost);
  });
});

// Source: developers.openai.com/api/docs/pricing, read 2026-10-17, the tier
// for prompts up to 272K tokens. Cache prices stay 0 on purpose (see the
// comment in openclaw-builtin-models.ts).
describe("openai list prices", () => {
  it.each([
    ["gpt-5.5", { input: 5, output: 30 }],
    ["gpt-5.4", { input: 2.5, output: 15 }],
    ["gpt-5.4-mini", { input: 0.75, output: 4.5 }],
  ])("openai/%s carries the published list price", (id, cost) => {
    const model = getModelCatalogForProvider("openai").find((m) => m.id === id);
    expect(model?.cost).toMatchObject(cost);
  });
});

// The vendored models.dev snapshot (scripts/update-model-catalog.mjs) is the
// project's machine-readable record of each model's limits. Hand-typed limits
// here drifted from it before: Opus 4.7 and Sonnet 4.6 were declared with a
// 200K window long after both shipped with 1M.
describe("agreement with the vendored models.dev snapshot", () => {
  const catalog = snapshot as Record<
    string,
    { contextWindow: number; maxTokens: number; vision: boolean }
  >;

  it.each(
    BUILT_IN_PROVIDERS.flatMap((provider) =>
      getModelCatalogForProvider(provider).map((m) => [`${provider}/${m.id}`, m] as const)
    )
  )("%s exists there, with the same context window and vision flag", (qualifiedId, model) => {
    // A missing entry is usually a typo in the id — the one mistake that makes
    // OpenClaw send a model name the provider answers with a 404.
    expect(Object.hasOwn(catalog, qualifiedId), qualifiedId).toBe(true);
    const reference = catalog[qualifiedId];
    expect(model.contextWindow).toBe(reference.contextWindow);
    expect(model.vision).toBe(reference.vision);
    // maxTokens becomes the request's output cap. Above the model's own limit
    // the provider rejects every request, so it may be lower, never higher.
    expect(model.maxTokens).toBeLessThanOrEqual(reference.maxTokens);
  });
});
