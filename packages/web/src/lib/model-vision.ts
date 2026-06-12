import { db } from "@/db";
import { models } from "@/db/schema";
import { sql } from "drizzle-orm";
import {
  modelHasCapability,
  loadModelCapabilityCache,
  invalidateModelCapabilityCache,
} from "@/lib/model-capabilities/cache";

export function isModelVisionCapable(modelId: string): boolean {
  return modelHasCapability(modelId, "vision");
}

export async function setOllamaLocalVisionModels(modelIds: Set<string>): Promise<void> {
  if (modelIds.size === 0) {
    invalidateModelCapabilityCache();
    await loadModelCapabilityCache();
    return;
  }
  const values = Array.from(modelIds, (modelId) => ({
    provider: "ollama",
    modelId,
    displayName: modelId,
    vision: true,
    longContext: false,
    tools: false,
    source: "detected",
  }));
  // Single bulk upsert + single cache rebuild — was previously N+1 round trips
  // plus N full table scans.
  await db
    .insert(models)
    .values(values)
    .onConflictDoUpdate({
      target: [models.provider, models.modelId],
      set: { vision: true, updatedAt: sql`now()` },
    });
  invalidateModelCapabilityCache();
  await loadModelCapabilityCache();
}
