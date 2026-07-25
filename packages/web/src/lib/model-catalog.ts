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

// Family → sole entry, computed once at load. Only families with EXACTLY one
// member are listed: a bare family-level id (e.g. "qwen", 32 members) must not
// resolve to an arbitrary variant, since its context window could be far larger
// than the requested model's and make compaction fire too late — the unsafe
// direction this module exists to prevent. Ambiguous families fall through to
// null, and the caller uses the small, compaction-safe DEFAULT_MODEL_CAPS.
const SOLE_FAMILY_ENTRY: Map<string, CatalogEntry> = (() => {
  const counts = new Map<string, number>();
  const first = new Map<string, CatalogEntry>();
  for (const e of Object.values(CATALOG)) {
    counts.set(e.family, (counts.get(e.family) ?? 0) + 1);
    if (!first.has(e.family)) first.set(e.family, e);
  }
  const sole = new Map<string, CatalogEntry>();
  for (const [family, count] of counts) {
    if (count === 1) sole.set(family, first.get(family)!);
  }
  return sole;
})();

/** Strip a leading `provider/` segment and any `:tag` suffix for family match. */
function normalizeId(id: string): string {
  return id.replace(/^[^/]+\//, "").replace(/:.*$/, "");
}

export function lookupModelCapabilities(modelId: string): OpenClawModelDefinition | null {
  // `modelId` is untrusted (a third-party /v1/models id). Guard every bracket
  // read with Object.hasOwn so a prototype key ("constructor", "toString", …)
  // can't return an inherited function and produce a malformed definition —
  // consistent with the Object.hasOwn discipline in build.ts/provider-models.ts.
  const exact = Object.hasOwn(CATALOG, modelId) ? CATALOG[modelId] : undefined;
  if (exact) return toDefinition(exact, modelId);
  const norm = normalizeId(modelId);
  // Defensive: snapshot keys are currently all single-slash and untagged, so
  // this never hits today. It covers a future refresh that emits unprefixed or
  // `:tag`-suffixed keys, where the normalized id is itself a catalog key.
  const byNorm = Object.hasOwn(CATALOG, norm) ? CATALOG[norm] : undefined;
  if (byNorm) return toDefinition(byNorm, modelId);
  // Rename path (e.g. "swisscom/mistral-large-2512"): specific, always safe.
  const byRenamedId = Object.values(CATALOG).find((e) => normalizeId(e.id) === norm);
  if (byRenamedId) return toDefinition(byRenamedId, modelId);
  // Bare family id: resolve ONLY when the family is unambiguous (one member).
  const soleFamily = SOLE_FAMILY_ENTRY.get(norm);
  return soleFamily ? toDefinition(soleFamily, modelId) : null;
}

function toDefinition(e: CatalogEntry, requestedId: string): OpenClawModelDefinition {
  // The catalog match only ENRICHES capabilities (contextWindow, cost, vision,
  // …). The id and name stay the endpoint's discovered id VERBATIM: OpenClaw
  // sends this string back as the `model` field at chat time (splitting only the
  // provider slug off `<slug>/<id>`), so a passthrough gateway that advertised a
  // namespaced `vendor/model` must get `vendor/model` back — de-prefixing it
  // here would 404 at chat time. `normalizeId` is used ONLY for catalog LOOKUP
  // above, never to rewrite the persisted/emitted id.
  const { family: _family, ...rest } = e;
  return { ...rest, id: requestedId, name: requestedId };
}
