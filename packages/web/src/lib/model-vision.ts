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
  for (const modelId of modelIds) {
    await db
      .insert(models)
      .values({
        provider: "ollama",
        modelId,
        displayName: modelId,
        vision: true,
        documents: false,
        audio: false,
        video: false,
        longContext: false,
        tools: false,
        source: "detected",
      })
      .onConflictDoUpdate({
        target: [models.provider, models.modelId],
        set: { vision: true, updatedAt: sql`now()` },
      });
  }
  invalidateModelCapabilityCache();
  await loadModelCapabilityCache();
}
