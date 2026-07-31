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

export function resolveCitedSourcePaths(
  citedPaths: string[],
  retrieved: readonly { sourcePath: string }[]
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const cited of citedPaths) {
    const matches = retrieved.filter(
      (r) => r.sourcePath === cited || r.sourcePath.endsWith(`/${cited}`)
    );
    // Zero matches: not retrieved. More than one: the citation is ambiguous.
    if (matches.length !== 1) continue;

    const sourcePath = matches[0].sourcePath;
    if (seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    resolved.push(sourcePath);
  }

  return resolved;
}
