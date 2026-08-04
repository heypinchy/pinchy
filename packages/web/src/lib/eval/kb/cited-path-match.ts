/**
 * Does a Sources entry name a document retrieval returned, and how completely?
 *
 * One question, asked in two places that must not answer it differently: the
 * `path-not-cited` grader decides whether a citation is *usable*, and the
 * groundedness lookup (`eval/kb/resolve-cited-paths.ts`) decides which passages
 * a claim may be checked against. Two implementations of "names this document"
 * would eventually disagree, and the disagreement would look like a model
 * defect — an answer graded as citing a fabricated path while its premise
 * material resolved fine, or the reverse.
 *
 * Matching is at SEGMENT boundaries in both directions, because the string a
 * model writes is not a path: it arrives wrapped in a code span, followed by a
 * quoted passage, or glossed in prose. None of that changes which document is
 * named; a character that continues a path segment does.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH, stated rather than left to be
 * rediscovered: the whole entry is scanned, so an entry whose own path is
 * fabricated resolves anyway if a real path appears ANYWHERE else in it —
 * `fabricated.md — "as stated in handbook-2012/policy.md, …"` matches the
 * handbook. Scanning the whole entry is precisely what makes the shapes the
 * sweep really produced work (a leading code span, a trailing gloss, a
 * `(undefined):` between path and quote), and the alternative — read only the
 * entry's first token — would drop `see /data/deep/policy.md`, which
 * `kb-resolve-cited-paths.test.ts` pins because groundedness hands this
 * function whole prose entries. So this is a bounded hole in the FABRICATION
 * direction, kept on purpose: it needs a model to quote a second, real path
 * beside its invented one, and nothing in the 43 archived sweep answers does.
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

/** Which retrieved document an entry names, and how much of its path it spells. */
export interface EntryMatch {
  sourcePath: string;
  /** The longest suffix of `sourcePath` the entry actually names. */
  named: string;
}

/**
 * The one retrieved document `entry` names, or null.
 *
 * Null covers the two distinct ways an entry fails to name a document, and the
 * caller has to tell them apart from the outside because only it knows what to
 * say about them: nothing matched (a fabricated path), or two documents matched
 * equally well (`policy.md` when both handbooks were retrieved — the ambiguity
 * a bare filename creates, which must NOT resolve).
 */
export function matchRetrievedDocument(
  entry: string,
  retrieved: readonly { sourcePath: string }[]
): EntryMatch | null {
  // Score every retrieved document by how specifically this entry names it.
  // `handbook-2012/policy.md: "…"` scores 23 for the 2012 document and 9
  // (`policy.md`) for its 2011 sibling, so the qualified path wins. A bare
  // `policy.md` scores 9 for both — a tie, and a tie is the ambiguity that
  // must not resolve.
  let best: EntryMatch | null = null;
  let tied = false;

  for (const { sourcePath } of retrieved) {
    const named = longestSuffixIn(entry, sourcePath);
    if (named.length === 0) continue;
    if (best === null || named.length > best.named.length) {
      best = { sourcePath, named };
      tied = false;
    } else if (named.length === best.named.length && sourcePath !== best.sourcePath) {
      tied = true;
    }
  }

  return tied ? null : best;
}
