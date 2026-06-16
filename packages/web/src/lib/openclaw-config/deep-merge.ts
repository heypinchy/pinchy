/**
 * Recursively merges `source` into `target`, returning a new object.
 *
 * Plain-object values are merged key-by-key; every other value type (arrays,
 * primitives, null, Date, …) from `source` REPLACES the one in `target`.
 * Arrays are intentionally not concatenated or element-merged — config
 * regeneration relies on a fresh array fully replacing the previous one.
 *
 * `target` is not mutated; nested plain objects are cloned along the merge
 * path. Used by `regenerateOpenClawConfig` to layer freshly-built config over
 * the existing openclaw.json while preserving OpenClaw-managed sub-trees.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
