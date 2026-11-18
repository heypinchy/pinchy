import { db } from "@/db";
import { models } from "@/db/schema";
import { sql } from "drizzle-orm";
import {
  modelCapabilityStatus,
  loadModelCapabilityCache,
  invalidateModelCapabilityCache,
} from "@/lib/model-capabilities/cache";
import snapshot from "@/lib/model-catalog-snapshot.json";

const SNAPSHOT = snapshot as Record<string, { vision?: boolean }>;

// Providers whose qualified ids share the snapshot's `vendor/model` keys.
const SNAPSHOT_KEYED_PROVIDERS = new Set(["anthropic", "openai", "google"]);

/**
 * Whether a model can read images.
 *
 * The capability table answers first. It is seeded from the curated catalog
 * only, though, and the built-in providers' model pickers list the LIVE
 * catalog — so a model the provider serves but this release does not curate
 * (a dated Claude snapshot, a model newer than the release) has no row. Read as
 * "no vision", such a model silently took its provider out of the pdf/image
 * chain and the knowledge-base OCR. For those, the vendored models.dev snapshot
 * decides, by exact id only: a fuzzy match could vouch for the wrong model.
 */
export function isModelVisionCapable(modelId: string): boolean {
  // agents.model is nullable in the DB, and some callers pass it straight in.
  if (!modelId) return false;
  const status = modelCapabilityStatus(modelId, "vision");
  if (status !== "unknown") return status === "supported";
  const provider = modelId.split("/")[0];
  if (!SNAPSHOT_KEYED_PROVIDERS.has(provider) || !Object.hasOwn(SNAPSHOT, modelId)) return false;
  return SNAPSHOT[modelId].vision === true;
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
