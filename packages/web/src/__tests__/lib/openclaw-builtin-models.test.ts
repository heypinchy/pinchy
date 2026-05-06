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
});
