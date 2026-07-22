import { db } from "@/db";
import { models } from "@/db/schema";
import type { ModelCapability } from "@/lib/model-resolver/types";
import type { ModelCapabilities } from "@/lib/model-capabilities/types";

export type { ModelCapabilities } from "@/lib/model-capabilities/types";

let cache: Map<string, ModelCapabilities> | null = null;
let warnedAboutUnloadedCache = false;

export async function loadModelCapabilityCache(): Promise<void> {
  const rows = await db.select().from(models);
  const next = new Map<string, ModelCapabilities>();
  for (const r of rows) {
    next.set(`${r.provider}/${r.modelId}`, {
      vision: r.vision ?? false,
      longContext: r.longContext ?? false,
      tools: r.tools ?? false,
    });
  }
  cache = next;
  warnedAboutUnloadedCache = false;
}

/**
 * Ensures the in-memory capability cache is populated. Safe to call from any
 * async server context that wants accurate capability data even if it runs
 * before bootInits has finished (e.g. an API route hit before the boot
 * sequence completes, or a test setup path).
 */
export async function ensureModelCapabilityCacheLoaded(): Promise<void> {
  if (cache === null) {
    await loadModelCapabilityCache();
  }
}

export function invalidateModelCapabilityCache(): void {
  cache = null;
}

export function getModelCapabilities(qualifiedModelId: string): ModelCapabilities | null {
  if (cache === null) {
    if (!warnedAboutUnloadedCache) {
      console.warn(
        "[pinchy] Model capability cache queried before load — returning null. " +
          "Call ensureModelCapabilityCacheLoaded() during boot or before this check."
      );
      warnedAboutUnloadedCache = true;
    }
    return null;
  }
  return cache.get(qualifiedModelId) ?? null;
}

/**
 * Three-valued capability lookup. Distinguishes "we know this model lacks the
 * capability" (`unsupported`) from "we have no cache row for this model"
 * (`unknown`) — a distinction `modelHasCapability` deliberately collapses to
 * `false`. Callers that must not treat a missing row as a proven absence (e.g.
 * the live-availability substitute check, which routinely sees models newer
 * than the curated capability catalog) use this instead.
 */
export function modelCapabilityStatus(
  qualifiedModelId: string,
  cap: ModelCapability
): "supported" | "unsupported" | "unknown" {
  const caps = getModelCapabilities(qualifiedModelId);
  if (!caps) return "unknown";
  const supported = (() => {
    switch (cap) {
      case "vision":
        return caps.vision;
      case "long-context":
        return caps.longContext;
      case "tools":
        return caps.tools;
    }
  })();
  return supported ? "supported" : "unsupported";
}

export function modelHasCapability(qualifiedModelId: string, cap: ModelCapability): boolean {
  return modelCapabilityStatus(qualifiedModelId, cap) === "supported";
}
