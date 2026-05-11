import { db } from "@/db";
import { models } from "@/db/schema";
import type { ModelCapability } from "@/lib/model-resolver/types";

export type ModelCapabilities = {
  vision: boolean;
  documents: boolean;
  audio: boolean;
  video: boolean;
  longContext: boolean;
  tools: boolean;
};

let cache: Map<string, ModelCapabilities> | null = null;

export async function loadModelCapabilityCache(): Promise<void> {
  const rows = await db.select().from(models);
  const next = new Map<string, ModelCapabilities>();
  for (const r of rows) {
    next.set(`${r.provider}/${r.modelId}`, {
      vision: r.vision ?? false,
      documents: r.documents ?? false,
      audio: r.audio ?? false,
      video: r.video ?? false,
      longContext: r.longContext ?? false,
      tools: r.tools ?? false,
    });
  }
  cache = next;
}

export function invalidateModelCapabilityCache(): void {
  cache = null;
}

export function getModelCapabilities(qualifiedModelId: string): ModelCapabilities | null {
  return cache?.get(qualifiedModelId) ?? null;
}

export function modelHasCapability(qualifiedModelId: string, cap: ModelCapability): boolean {
  const caps = getModelCapabilities(qualifiedModelId);
  if (!caps) return false;
  switch (cap) {
    case "vision":
      return caps.vision;
    case "documents":
      return caps.documents;
    case "audio":
      return caps.audio;
    case "video":
      return caps.video;
    case "long-context":
      return caps.longContext;
    case "tools":
      return caps.tools;
  }
}
