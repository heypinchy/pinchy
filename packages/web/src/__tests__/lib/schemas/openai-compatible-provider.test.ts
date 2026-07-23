import { describe, it, expect, expectTypeOf } from "vitest";
import {
  modelDefinitionSchema,
  upsertOpenAiCompatibleProviderSchema,
  discoverSchema,
  deleteOpenAiCompatibleSchema,
  type ModelDefinitionInput,
} from "@/lib/schemas/openai-compatible-provider";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";

// These schemas are the single source of truth for the OpenAI-compatible
// provider write paths, imported by BOTH the route handlers (parseRequestBody)
// and the client components (typed bodies via z.infer). AGENTS.md "Shared
// Schemas And Typed Client".

const validModel = {
  id: "gpt-4o",
  name: "GPT-4o",
  contextWindow: 128000,
  maxTokens: 16384,
  reasoning: false,
  vision: true,
  input: ["text", "image"],
  cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
};

describe("upsertOpenAiCompatibleProviderSchema", () => {
  it("accepts a valid create payload (apiKey + one model)", () => {
    const parsed = upsertOpenAiCompatibleProviderSchema.safeParse({
      displayName: "My Provider",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret",
      models: [validModel],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an update payload WITHOUT apiKey (optional, keeps existing key)", () => {
    const parsed = upsertOpenAiCompatibleProviderSchema.safeParse({
      id: "123e4567-e89b-12d3-a456-426614174000",
      displayName: "My Provider",
      baseUrl: "https://api.example.com/v1",
      models: [validModel],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty models array", () => {
    const parsed = upsertOpenAiCompatibleProviderSchema.safeParse({
      displayName: "My Provider",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret",
      models: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-URL baseUrl", () => {
    const parsed = upsertOpenAiCompatibleProviderSchema.safeParse({
      displayName: "My Provider",
      baseUrl: "not-a-url",
      apiKey: "sk-secret",
      models: [validModel],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-uuid id when present", () => {
    const parsed = upsertOpenAiCompatibleProviderSchema.safeParse({
      id: "not-a-uuid",
      displayName: "My Provider",
      baseUrl: "https://api.example.com/v1",
      models: [validModel],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("modelDefinitionSchema", () => {
  it("accepts a valid model definition", () => {
    expect(modelDefinitionSchema.safeParse(validModel).success).toBe(true);
  });

  it("rejects a missing contextWindow", () => {
    const { contextWindow: _omit, ...withoutContext } = validModel;
    expect(modelDefinitionSchema.safeParse(withoutContext).success).toBe(false);
  });

  it("rejects a zero contextWindow (must be positive int)", () => {
    const parsed = modelDefinitionSchema.safeParse({ ...validModel, contextWindow: 0 });
    expect(parsed.success).toBe(false);
  });

  // Compile-time parity guard (real check via tsconfig.typecheck.json, AGENTS.md
  // "Web Test Files Are Type-Checked"): the inferred model type must stay
  // structurally equal to the OpenClawModelDefinition interface this schema
  // validates. A field added to one but not the other breaks typecheck in CI
  // instead of silently drifting.
  it("ModelDefinitionInput stays structurally equal to OpenClawModelDefinition", () => {
    expectTypeOf<ModelDefinitionInput>().toEqualTypeOf<OpenClawModelDefinition>();
  });
});

describe("discoverSchema", () => {
  it("accepts a valid payload", () => {
    const parsed = discoverSchema.safeParse({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid payload (bad URL, empty key)", () => {
    expect(discoverSchema.safeParse({ baseUrl: "nope", apiKey: "sk" }).success).toBe(false);
    expect(
      discoverSchema.safeParse({ baseUrl: "https://api.example.com/v1", apiKey: "" }).success
    ).toBe(false);
  });
});

describe("deleteOpenAiCompatibleSchema", () => {
  it("accepts a valid uuid id", () => {
    const parsed = deleteOpenAiCompatibleSchema.safeParse({
      id: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-uuid id", () => {
    expect(deleteOpenAiCompatibleSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
