/**
 * The sweep cites one path and looks up another (#869, found by the first
 * probe that got far enough to produce a scorecard).
 *
 * `pinchy-knowledge` deliberately keeps two paths per hit and says why:
 * `sourcePath` is absolute and IDENTIFIES the document, `citationPath` is
 * relative to the data root and is "the only one that belongs" in a citation.
 * The model is shown — and correctly reproduces — the relative one. The
 * harness then queried `kb_chunks WHERE source_path = ANY(...)` with it, which
 * never matches, so `citedPassageTexts` came back empty for every run and the
 * NLI judge's conservative fallback tagged all 12 answers `ungrounded-claim`.
 * Including this one, which is entirely correct:
 *
 *     "Northwind replaces employee laptops on a 3-year refresh cycle …[1]
 *      **Sources**
 *      [1] `it-equipment-policy.md`: "…replaced on a 3-year refresh cycle…""
 *
 * The resolution is bound to what the tool actually returned, not to a guessed
 * root. That matters most where it REFUSES to resolve: a bare `policy.md` is
 * genuinely ambiguous between `handbook-2011/` and `handbook-2012/`, and that
 * ambiguity is the `path-not-cited` defect the whole path-citation axis exists
 * to catch. A harness that helpfully picked one would grade a citation defect
 * as grounded.
 *
 * The INPUTS below are transcribed from a real sweep's trajectories, not
 * invented. `citedSourcePaths` does not hand back a path — it hands back the
 * whole Sources entry, backticks, colon, quoted passage and all. A first cut
 * of this function compared those strings to `sourcePath` for equality and
 * resolved nothing at all, on a run where every answer cited correctly. What
 * matters is which document an entry NAMES, and how specifically.
 */

import { describe, expect, it } from "vitest";

import {
  premiseSourcePaths,
  resolveCitedSourcePaths,
} from "../../../../eval/kb/resolve-cited-paths";
import {
  citedSourcePaths,
  gradeAttribution,
  gradePathCitation,
} from "@/lib/eval/kb/attribution-graders";

const RETRIEVED = [
  { sourcePath: "/data/it-equipment-policy.md" },
  { sourcePath: "/data/handbook-2011/policy.md" },
  { sourcePath: "/data/handbook-2012/policy.md" },
];

describe("resolveCitedSourcePaths", () => {
  it("resolves the relative citation path the tool showed the model", () => {
    expect(resolveCitedSourcePaths(["it-equipment-policy.md"], RETRIEVED)).toEqual([
      "/data/it-equipment-policy.md",
    ]);
  });

  it("resolves a real Sources entry, backticks and quoted passage included", () => {
    // Verbatim from a kimi-k2.6 run (gqa-happy-1).
    const entry =
      '`it-equipment-policy.md`: "Northwind issues each full-time employee a ' +
      'standard-configuration laptop upon hire, replaced on a 3-year refresh cycle."';

    expect(resolveCitedSourcePaths([entry], RETRIEVED)).toEqual(["/data/it-equipment-policy.md"]);
  });

  it("prefers the folder-qualified sibling when an entry names one of two", () => {
    // Verbatim from gqa-pathcite-2, where both handbook years were retrieved.
    const entry =
      'handbook-2012/policy.md: "Effective the 2012 revision, the daily meal per diem ' +
      'for approved business travel was increased from $45 to $60."';

    expect(resolveCitedSourcePaths([entry], RETRIEVED)).toEqual(["/data/handbook-2012/policy.md"]);
  });

  it("refuses an entry that names only the shared basename", () => {
    const entry = '`policy.md` — "the daily meal per diem was increased"';

    expect(resolveCitedSourcePaths([entry], RETRIEVED)).toEqual([]);
  });

  it("keeps an already-absolute path as it is", () => {
    expect(resolveCitedSourcePaths(["/data/it-equipment-policy.md"], RETRIEVED)).toEqual([
      "/data/it-equipment-policy.md",
    ]);
  });

  it("resolves a folder-qualified path that disambiguates a shared basename", () => {
    expect(resolveCitedSourcePaths(["handbook-2012/policy.md"], RETRIEVED)).toEqual([
      "/data/handbook-2012/policy.md",
    ]);
  });

  it("refuses a bare basename two retrieved documents share", () => {
    // The ambiguity IS the finding (path-not-cited). Resolving it would hand
    // premise material to an answer whose citation cannot be checked.
    expect(resolveCitedSourcePaths(["policy.md"], RETRIEVED)).toEqual([]);
  });

  it("refuses a path the search never returned", () => {
    // A fabricated citation must not acquire evidence on the way through.
    expect(resolveCitedSourcePaths(["invented-policy.md"], RETRIEVED)).toEqual([]);
  });

  it("refuses a fabricated name that merely ENDS with a retrieved filename", () => {
    // The refusal above only holds if the match respects segment boundaries.
    // A plain substring test reads `my-policy.md` as containing `policy.md`
    // and hands the fabrication the real document's passages — the exact
    // failure the module's first stated property rules out. Same one level up:
    // `old-handbook-2012/` must not answer for `handbook-2012/`.
    expect(
      resolveCitedSourcePaths(["`my-policy.md`"], [{ sourcePath: "/data/policy.md" }])
    ).toEqual([]);
    expect(
      resolveCitedSourcePaths(
        ["old-handbook-2012/policy.md"],
        [{ sourcePath: "/data/handbook-2012/policy.md" }]
      )
    ).toEqual([]);
  });

  it("still resolves a filename that begins right after a path separator", () => {
    // The boundary rule must not cost the ordinary case: an entry naming the
    // absolute path contains `policy.md` preceded by `/`, which is a boundary,
    // not a fabrication.
    expect(
      resolveCitedSourcePaths(
        ["see /data/deep/policy.md"],
        [{ sourcePath: "/data/deep/policy.md" }]
      )
    ).toEqual(["/data/deep/policy.md"]);
  });

  it("resolves each cited path once, preserving citation order", () => {
    const resolved = resolveCitedSourcePaths(
      ["handbook-2012/policy.md", "it-equipment-policy.md", "handbook-2012/policy.md"],
      RETRIEVED
    );

    expect(resolved).toEqual(["/data/handbook-2012/policy.md", "/data/it-equipment-policy.md"]);
  });

  it("returns nothing when the answer cited nothing", () => {
    expect(resolveCitedSourcePaths([], RETRIEVED)).toEqual([]);
  });

  it("returns nothing when the search returned nothing", () => {
    expect(resolveCitedSourcePaths(["it-equipment-policy.md"], [])).toEqual([]);
  });
});

/**
 * The two readers of `matchRetrievedDocument`, asked the same question.
 *
 * Sharing one implementation is the point of `cited-path-match.ts`, and until
 * this block nothing failed if someone gave either side a local copy back. The
 * disagreement would not read as a harness bug either — it would be booked
 * against the MODEL: an answer graded as citing a fabricated path while its
 * premise material resolved fine, or one whose citation axis reads green while
 * `citedPassageTexts` comes back empty and the NLI judge's conservative
 * fallback charges every sentence `ungrounded-claim`. That is exactly the shape
 * of #869, which cost a whole sweep.
 *
 * `citedSourcePaths` is what the real sweep hands the resolver
 * (`kb-eval-models.spec.ts`), so the two sides here get the same string from
 * the same parser — the wiring, not a re-statement of it.
 */
describe("gradePathCitation and resolveCitedSourcePaths agree on which document an entry names", () => {
  const answerCiting = (entry: string) => `X [1].\n\n**Sources:**\n\n- [1] ${entry}`;

  const resolvesFor = (entry: string, retrieved: { sourcePath: string }[]) =>
    resolveCitedSourcePaths(citedSourcePaths(answerCiting(entry)), retrieved);

  const graded = (entry: string, retrieved: { sourcePath: string }[]) =>
    gradePathCitation({
      answer: answerCiting(entry),
      retrieved: retrieved.map((source, i) => ({
        n: i + 1,
        sourcePath: source.sourcePath,
        page: 1,
      })),
    });

  it.each([
    ["the citation path the tool printed", "it-equipment-policy.md"],
    ["the absolute path", "/data/it-equipment-policy.md"],
    ["the path from the mount", "data/it-equipment-policy.md"],
    ["a code span and a quoted passage", '`it-equipment-policy.md`: "…3-year refresh cycle."'],
    ["a folder-qualified sibling", 'handbook-2012/policy.md — "the per diem was increased"'],
  ])("a citation graded PASS resolves to one document (%s)", (_label, entry) => {
    expect(graded(entry, RETRIEVED).passed).toBe(true);
    expect(resolvesFor(entry, RETRIEVED)).toHaveLength(1);
  });

  it.each([
    ["a shared bare basename", "policy.md"],
    ["a path the search never returned", "invented-policy.md"],
    ["a name that merely ends with a real one", "`my-it-equipment-policy.md`"],
    ["an invented parent folder", "old-handbook-2012/policy.md"],
  ])("a citation that resolves to nothing is graded FAIL (%s)", (_label, entry) => {
    expect(resolvesFor(entry, RETRIEVED)).toEqual([]);
    expect(graded(entry, RETRIEVED).tags).toEqual(["path-not-cited"]);
  });

  it("keeps the one asymmetry the two sides are meant to have", () => {
    // An unambiguous PARTIAL path: the reader cannot act on `OLD/…` alone, so
    // the citation axis charges it — but it names one document and nothing
    // else, so groundedness may check the claim against that document's
    // passages rather than fall back to "unsupported". Collapsing the two into
    // one verdict would either excuse an unusable citation or withhold premise
    // material from a claim whose source is not in doubt.
    const retrieved = [{ sourcePath: "/data/quality/OLD/afnor-certificate-2013.md" }];

    expect(graded("OLD/afnor-certificate-2013.md", retrieved).tags).toEqual(["path-not-cited"]);
    expect(resolvesFor("OLD/afnor-certificate-2013.md", retrieved)).toEqual([
      "/data/quality/OLD/afnor-certificate-2013.md",
    ]);
  });
});

/**
 * The same false alarm, one layer down, and the one that mattered most.
 *
 * `citedSourcePaths` resolves the INTERSECTION of what the answer cites inline
 * and what its Sources list holds — and it reads that list through
 * `BULLET_LINE`, which requires `- [N] …`. When a model writes the list any
 * other way the intersection is empty, so the premise set is empty, so
 * `gradeGroundednessForGold` entailment-scores every sentence against `""` and
 * charges `ungrounded-claim`. In the 2026-08-03 sweep that was 23 of 29
 * `ungrounded-claim` verdicts, and 12 of 12 runs for `gpt-oss:120b` — whose
 * 0/12 therefore measured this parser, not the model.
 *
 * The intersection is NOT dropped: where the list parses, a listed-but-uncited
 * source must still not ground a claim, and that guarantee is free there. It is
 * simply not computable in the shapes above — glm-5.2 writes
 * `1. path — passage [1]`, with the number trailing — so an empty strict result
 * falls back to "every retrieved document the Sources region names", which
 * needs no structure at all.
 *
 * What bounds the fallback's lower precision: it only ever runs when the strict
 * parse found nothing, and an answer whose list does not parse ALWAYS carries
 * `sources-format` or `citation-unresolved` from `gradeAttribution`. So the
 * fallback can never turn a failing run into a passing one — it can only stop
 * `ungrounded-claim` from firing on a claim whose source was never in doubt.
 */
describe("premiseSourcePaths", () => {
  const SWEEP_SHAPES: [string, string][] = [
    [
      "no list marker at all (kimi-k2.6, gpt-oss:120b)",
      'Laptops are replaced on a 3-year cycle [1].\n\n**Sources**\n[1] `it-equipment-policy.md`: "…replaced on a 3-year refresh cycle…"',
    ],
    [
      "an ordered list with the number trailing (glm-5.2)",
      "Coverage expanded in 2012 [1].\n\n### Sources\n\n1. handbook-2012/policy.md — passage [1]",
    ],
    [
      "an ordered list carrying the citation number (qwen3.5:397b)",
      'The per diem rose to $60 [1].\n\n**Sources:**\n1. handbook-2012/policy.md — "…increased from $45 to $60…"',
    ],
    [
      "a run-on paragraph, the shape sources-format was built for",
      "One [1]. Two [2].\n\n**Sources:** [1] handbook-2011/policy.md — p. 1 [2] handbook-2012/policy.md — p. 2",
    ],
  ];

  it.each(SWEEP_SHAPES)("recovers premise material from %s", (_label, answer) => {
    expect(premiseSourcePaths(answer, RETRIEVED).length).toBeGreaterThan(0);
  });

  it("prefers the strict intersection whenever it resolves anything", () => {
    // [2] is listed but never cited inline. The strict path excludes it, and
    // because the strict path is non-empty the fallback never runs — so the
    // guarantee that an uncited source cannot ground a claim is untouched.
    const answer = `Fact one [1].

**Sources:**

- [1] it-equipment-policy.md — p. 1
- [2] handbook-2012/policy.md — p. 2`;

    expect(premiseSourcePaths(answer, RETRIEVED)).toEqual(["/data/it-equipment-policy.md"]);
  });

  it("still refuses a fabricated path and an ambiguous basename in the fallback", () => {
    // No structure to parse, so the fallback runs — and it resolves through the
    // same matcher, which means it inherits both refusals rather than being a
    // looser second door into the premise set.
    const fabricated = "A claim [1].\n\n**Sources**\n[1] invented-policy.md";
    const ambiguous = "A claim [1].\n\n**Sources**\n[1] policy.md";

    expect(premiseSourcePaths(fabricated, RETRIEVED)).toEqual([]);
    expect(premiseSourcePaths(ambiguous, RETRIEVED)).toEqual([]);
  });

  it("returns nothing for an answer with no Sources list at all", () => {
    // An abstention, or a model that asserted without citing. Nothing was
    // claimed to be a source, so there is nothing to recover — and
    // `ungrounded-claim` on an uncited assertion is a fair verdict, not an
    // artefact.
    expect(premiseSourcePaths("I couldn't find this in the knowledge base.", RETRIEVED)).toEqual(
      []
    );
  });

  it("cannot turn a failing run into a passing one — the bound the fallback rests on", () => {
    // Every shape the fallback exists for is charged by gradeAttribution
    // independently. Assert that rather than trusting the reasoning: if a
    // future parser change made one of these shapes grade clean, the fallback's
    // lower precision would start affecting verdicts and this test says so.
    // `gradeAttribution` grades the full retrieved shape, so the citation
    // number and page the tool reported are supplied here; the premise lookup
    // above needs only the path and is typed accordingly.
    const graded = RETRIEVED.map((source, i) => ({ ...source, n: i + 1, page: 1 }));

    for (const [, answer] of SWEEP_SHAPES) {
      const tags = gradeAttribution({ answer, retrieved: graded }).tags;
      expect(tags.some((t) => t === "sources-format" || t === "citation-unresolved")).toBe(true);
    }
  });
});
