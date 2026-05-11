import { beforeEach, it, expect } from "vitest";
import {
  loadModelCapabilityCache,
  getModelCapabilities,
  invalidateModelCapabilityCache,
} from "@/lib/model-capabilities/cache";
import { db } from "@/db";
import { models } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { seedBuiltinModels } from "@/lib/model-capabilities/seed";

beforeEach(async () => {
  await db.delete(models);
  await seedBuiltinModels();
  invalidateModelCapabilityCache();
});

it("returns capabilities for a known model after load", async () => {
  await loadModelCapabilityCache();
  const caps = getModelCapabilities("anthropic/claude-opus-4-7");
  expect(caps).toEqual({
    vision: true,
    documents: true,
    audio: false,
    video: false,
    longContext: true,
    tools: true,
  });
});

it("returns null for unknown model", async () => {
  await loadModelCapabilityCache();
  expect(getModelCapabilities("provider-x/model-y")).toBeNull();
});

it("re-reads after invalidation", async () => {
  await loadModelCapabilityCache();
  // Mutate DB directly
  await db
    .update(models)
    .set({ vision: false })
    .where(and(eq(models.provider, "anthropic"), eq(models.modelId, "claude-opus-4-7")));
  // Stale cache still returns true
  expect(getModelCapabilities("anthropic/claude-opus-4-7")?.vision).toBe(true);
  invalidateModelCapabilityCache();
  await loadModelCapabilityCache();
  expect(getModelCapabilities("anthropic/claude-opus-4-7")?.vision).toBe(false);
});
