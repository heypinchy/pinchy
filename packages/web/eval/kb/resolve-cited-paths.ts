/**
 * Maps the paths an answer cites onto the paths `kb_chunks` is keyed by.
 *
 * `pinchy-knowledge` shows the model `citationPath` — relative to the data
 * root, because that is what a reader can act on — while the database keys
 * chunks by the absolute `sourcePath`. Both are deliberate; what was missing
 * is the step between them, so the groundedness premise lookup asked for
 * `it-equipment-policy.md` and the column held `/data/it-equipment-policy.md`.
 *
 * Resolution runs against what the search ACTUALLY returned for this run, not
 * against a configured root. Two properties follow from that, and both are the
 * point rather than a side effect:
 *
 *   - A path the search never returned stays unresolved, so a fabricated
 *     citation cannot pick up premise material on its way through.
 *   - A basename shared by two retrieved documents stays unresolved. That
 *     ambiguity is exactly the `path-not-cited` defect the path-citation axis
 *     exists to catch; resolving it would grade a citation defect as grounded.
 */

/**
 * Every path suffix of `sourcePath` at segment boundaries, longest last:
 * `/data/handbook-2012/policy.md` → `policy.md`, `handbook-2012/policy.md`,
 * `data/handbook-2012/policy.md`, …
 */
function pathSuffixes(sourcePath: string): string[] {
  const segments = sourcePath.split("/").filter(Boolean);
  return segments.map((_, i) => segments.slice(segments.length - 1 - i).join("/"));
}

/** The longest suffix of `sourcePath` that appears in `entry`, or "" for none. */
function longestSuffixIn(entry: string, sourcePath: string): string {
  let best = "";
  for (const suffix of pathSuffixes(sourcePath)) {
    if (entry.includes(suffix) && suffix.length > best.length) best = suffix;
  }
  return best;
}

export function resolveCitedSourcePaths(
  citedEntries: string[],
  retrieved: readonly { sourcePath: string }[]
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const entry of citedEntries) {
    // Score every retrieved document by how specifically this entry names it.
    // `handbook-2012/policy.md: "…"` scores 23 for the 2012 document and 9
    // (`policy.md`) for its 2011 sibling, so the qualified path wins. A bare
    // `policy.md` scores 9 for both — a tie, and a tie is the ambiguity that
    // must NOT resolve.
    let best: { sourcePath: string; score: number } | null = null;
    let tied = false;

    for (const { sourcePath } of retrieved) {
      const score = longestSuffixIn(entry, sourcePath).length;
      if (score === 0) continue;
      if (best === null || score > best.score) {
        best = { sourcePath, score };
        tied = false;
      } else if (score === best.score && sourcePath !== best.sourcePath) {
        tied = true;
      }
    }

    if (best === null || tied) continue;
    if (seen.has(best.sourcePath)) continue;
    seen.add(best.sourcePath);
    resolved.push(best.sourcePath);
  }

  return resolved;
}
