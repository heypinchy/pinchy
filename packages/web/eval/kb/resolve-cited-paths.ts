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
 * `data/handbook-2012/policy.md`, `/data/handbook-2012/policy.md`.
 *
 * The leading-slash form is a candidate in its own right, not a cosmetic
 * duplicate: an entry that spells the path out absolutely must be able to win
 * with the WHOLE path, because a win is rejected below when more path precedes
 * it. Without this candidate the longest match would be `data/…`, preceded by
 * the `/` the entry does have, and a correctly-cited absolute path would be
 * thrown out as over-qualified.
 */
function pathSuffixes(sourcePath: string): string[] {
  const segments = sourcePath.split("/").filter(Boolean);
  const suffixes = segments.map((_, i) => segments.slice(segments.length - 1 - i).join("/"));
  if (sourcePath.startsWith("/")) suffixes.push(`/${segments.join("/")}`);
  return suffixes;
}

/**
 * What may NOT flank a suffix occurrence for it to count as naming the
 * document. Both directions rule out a fabrication picking up real passages:
 *
 *   - to the left, any character that continues a segment (`my-policy.md`)
 *     AND `/` itself, because a preceding separator means the entry names a
 *     parent the document does not have. That is the whole distinction between
 *     `handbook-2012/policy.md` and `old-handbook-2012/policy.md`: the shorter
 *     suffix `policy.md` sits at a real boundary in both, and only the
 *     separator to its left says the second one is a different document.
 *   - to the right, a segment character (`policy.mdx`). `.` is deliberately
 *     absent here so an entry ending its sentence with "…in policy.md." still
 *     resolves; it IS present on the left, where `my.policy.md` needs it.
 */
const SEGMENT_CHAR_BEFORE = /[A-Za-z0-9._/-]/;
const SEGMENT_CHAR_AFTER = /[A-Za-z0-9_-]/;

/** Whether `suffix` occurs in `entry` as a whole path segment, not mid-name. */
function mentionsSuffix(entry: string, suffix: string): boolean {
  // Every occurrence, not just the first: an entry may name the document twice
  // and only the second one sit at a boundary.
  let at = entry.indexOf(suffix);
  while (at !== -1) {
    const before = at === 0 ? "" : entry[at - 1];
    const after = entry[at + suffix.length] ?? "";
    if (!SEGMENT_CHAR_BEFORE.test(before) && !SEGMENT_CHAR_AFTER.test(after)) return true;
    at = entry.indexOf(suffix, at + 1);
  }
  return false;
}

/** The longest suffix of `sourcePath` that `entry` names, or "" for none. */
function longestSuffixIn(entry: string, sourcePath: string): string {
  let best = "";
  for (const suffix of pathSuffixes(sourcePath)) {
    if (suffix.length > best.length && mentionsSuffix(entry, suffix)) best = suffix;
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
