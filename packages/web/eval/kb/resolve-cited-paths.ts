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

// Relative, not `@/`: this is a VALUE import, and the alias is only safe in
// `eval/` for `import type` (which erases). `run-eval.ts` reaches into `src/`
// the same way, for the same reason — a Playwright spec loads these files
// directly.
import { citedSourcePaths, sourcesListCandidates } from "../../src/lib/eval/kb/attribution-graders";
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

/**
 * The documents a claim may be checked against — strictly if the Sources list
 * parses, and by naming alone if it does not.
 *
 * `citedSourcePaths` reads the list through `BULLET_LINE` and returns the
 * INTERSECTION of inline citations and list entries. That intersection is a
 * real guarantee — a source listed but never cited must not ground a claim —
 * and it is kept wherever it can be computed. What it cannot survive is a list
 * written any other way: the intersection comes back empty, so the premise set
 * is empty, so `gradeGroundednessForGold` entailment-scores every sentence
 * against `""` and charges `ungrounded-claim`. The 2026-08-03 sweep spent 23 of
 * its 29 `ungrounded-claim` verdicts that way, including all 12 runs of
 * `gpt-oss:120b` — whose 0/12 measured this parser rather than the model.
 *
 * The intersection is not computable in those shapes rather than merely
 * inconvenient: `glm-5.2` writes `1. <path> — passage [1]`, with the number
 * TRAILING the path, so no split attaches a citation number to a document. So
 * an empty strict result falls back to what needs no structure at all — which
 * retrieved documents the Sources region names — resolved through the same
 * matcher, which means the fallback inherits its refusals rather than being a
 * looser second door: a fabricated path and an ambiguous bare basename resolve
 * to nothing on both routes.
 *
 * What bounds the fallback's lower precision, and why it is safe to be less
 * precise here: it runs ONLY when the strict parse found nothing, and an answer
 * whose list does not parse always carries `sources-format` or
 * `citation-unresolved` from `gradeAttribution`. The run therefore fails either
 * way — the fallback can never turn a failing run into a passing one, only stop
 * `ungrounded-claim` from firing on a claim whose source was never in doubt.
 * `kb-resolve-cited-paths.test.ts` asserts that bound against every shape this
 * exists for, rather than leaving it as an argument in a comment.
 */
export function premiseSourcePaths(
  answer: string,
  retrieved: readonly { sourcePath: string }[]
): string[] {
  const strict = resolveCitedSourcePaths(citedSourcePaths(answer), retrieved);
  if (strict.length > 0) return strict;

  return resolveCitedSourcePaths(sourcesListCandidates(answer), retrieved);
}
