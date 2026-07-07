import { describe, it, expect } from "vitest";
import { getModelCatalogForProvider } from "@/lib/openclaw-builtin-models";

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
