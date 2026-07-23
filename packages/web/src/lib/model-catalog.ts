import snapshot from "@/lib/model-catalog-snapshot.json";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";

type CatalogEntry = OpenClawModelDefinition & { family: string };
const CATALOG = snapshot as Record<string, CatalogEntry>;

// Conservative fallback for ids absent from the snapshot. Small context ⇒
// compaction fires early (safe direction, per the deepseek-v4-pro incident).
export const DEFAULT_MODEL_CAPS: OpenClawModelDefinition = {
  id: "",
  name: "",
  contextWindow: 32768,
  maxTokens: 8192,
  reasoning: false,
  vision: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Strip a leading `provider/` segment and any `:tag` suffix for family match. */
function normalizeId(id: string): string {
  return id.replace(/^[^/]+\//, "").replace(/:.*$/, "");
}

export function lookupModelCapabilities(modelId: string): OpenClawModelDefinition | null {
  const exact = CATALOG[modelId];
  if (exact) return toDefinition(exact, modelId);
  const norm = normalizeId(modelId);
  const byNorm = CATALOG[norm];
  if (byNorm) return toDefinition(byNorm, modelId);
  const byFamily = Object.values(CATALOG).find(
    (e) => e.family === norm || normalizeId(e.id) === norm
  );
  return byFamily ? toDefinition(byFamily, modelId) : null;
}

function toDefinition(e: CatalogEntry, requestedId: string): OpenClawModelDefinition {
  const { family: _family, ...rest } = e;
  return { ...rest, id: normalizeId(requestedId), name: requestedId };
}
