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
 *
 * The matching itself lives in `src/lib/eval/kb/cited-path-match.ts`, shared
 * with that axis — see its header for why one implementation rather than two.
 */

import { matchRetrievedDocument } from "../../src/lib/eval/kb/cited-path-match";

export function resolveCitedSourcePaths(
  citedEntries: string[],
  retrieved: readonly { sourcePath: string }[]
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const entry of citedEntries) {
    const match = matchRetrievedDocument(entry, retrieved);
    if (match === null) continue;
    if (seen.has(match.sourcePath)) continue;
    seen.add(match.sourcePath);
    resolved.push(match.sourcePath);
  }

  return resolved;
}
