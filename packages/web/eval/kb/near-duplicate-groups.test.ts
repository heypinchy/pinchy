/**
 * The corpus knows which of its documents restate one fact — and until now it
 * knew it only in a header comment.
 *
 * `gradeNoDuplicateCorroboration` scores the Sources list against
 * `nearDuplicateGroups` and passes unconditionally when that list is empty.
 * `gradeKbRun` never supplied one, so `dedup-inflation` could not fire in any
 * pipeline that produces a published number: its 0 in `data/README.md` meant
 * "not asked", not "did not happen" — a cell that reads as a measurement and
 * is not one, which is the exact defect this dataset's discipline exists to
 * catch.
 *
 * These tests pin the wiring that closes it. The fact lives on the chunk, as
 * `factGroup`, where the author writing the duplicate passage is standing; the
 * path groups are derived from that rather than hand-listed somewhere else,
 * because a hand-maintained list that mirrors code will be wrong.
 */
import { describe, expect, it } from "vitest";

import { KB_EVAL_CORPUS, nearDuplicatePathGroups } from "./corpus/manifest";
import type { CorpusDoc } from "./corpus/manifest";

describe("nearDuplicatePathGroups", () => {
  it("derives the two near-duplicate pairs the corpus was built to carry", () => {
    const groups = nearDuplicatePathGroups().map((group) => [...group].sort());

    expect(groups).toContainEqual(["/data/product-insert.md", "/data/quality-file.md"]);
    expect(groups).toContainEqual(["/data/petrifilm-datasheet.md", "/data/quality-binder.md"]);
  });

  it("finds a real corpus, so an extractor that reads nothing cannot pass quietly", () => {
    // Corpus floor, same reason as readme-tag-coverage.test.ts's: a derivation
    // that returns [] restores the unreachable-tag bug, and every assertion
    // above it would still be satisfiable by an empty result.
    expect(nearDuplicatePathGroups().length).toBeGreaterThanOrEqual(2);
  });

  it("groups by fact, not by document, so a third restatement joins its pair", () => {
    const corpus: CorpusDoc[] = [
      {
        sourcePath: "/data/a.md",
        file: "a.md",
        chunks: [{ id: "a#c1", page: 1, text: "x", factGroup: "one-fact" }],
      },
      {
        sourcePath: "/data/b.md",
        file: "b.md",
        chunks: [{ id: "b#c1", page: 1, text: "y", factGroup: "one-fact" }],
      },
      {
        sourcePath: "/data/c.md",
        file: "c.md",
        chunks: [{ id: "c#c1", page: 1, text: "z", factGroup: "one-fact" }],
      },
    ];

    expect(nearDuplicatePathGroups(corpus)).toEqual([["/data/a.md", "/data/b.md", "/data/c.md"]]);
  });

  it("counts a document once even when several of its chunks carry the group", () => {
    const corpus: CorpusDoc[] = [
      {
        sourcePath: "/data/a.md",
        file: "a.md",
        chunks: [
          { id: "a#c1", page: 1, text: "x", factGroup: "one-fact" },
          { id: "a#c2", page: 1, text: "x again", factGroup: "one-fact" },
        ],
      },
      {
        sourcePath: "/data/b.md",
        file: "b.md",
        chunks: [{ id: "b#c1", page: 1, text: "y", factGroup: "one-fact" }],
      },
    ];

    // Two chunks of ONE document are not two sources. Counting the path twice
    // would let the grader charge dedup-inflation for citing a single document.
    expect(nearDuplicatePathGroups(corpus)).toEqual([["/data/a.md", "/data/b.md"]]);
  });

  it("throws on a factGroup that reaches only one document, rather than dropping it", () => {
    const corpus: CorpusDoc[] = [
      {
        sourcePath: "/data/a.md",
        file: "a.md",
        chunks: [{ id: "a#c1", page: 1, text: "x", factGroup: "typo-in-the-group-name" }],
      },
      {
        sourcePath: "/data/b.md",
        file: "b.md",
        chunks: [{ id: "b#c1", page: 1, text: "y", factGroup: "typo-in-the-group-nane" }],
      },
    ];

    // Silently filtering a one-document group is how this bug comes back: a
    // mistyped group name would leave BOTH halves ungrouped, the pair would
    // stop being compared, and dedup-inflation would go quiet again with
    // nothing red. The typo must be an error, not a shrug.
    expect(() => nearDuplicatePathGroups(corpus)).toThrow(/typo-in-the-group-name/);
  });

  it("names a factGroup on every document the corpus header claims restates a fact", () => {
    // The header comment is prose and cannot be checked; this is the part of it
    // that can be. Each pair below is described there as one fact in two
    // documents, so each must be reachable by the grader.
    const grouped = new Set(nearDuplicatePathGroups().flat());

    for (const sourcePath of [
      "/data/product-insert.md",
      "/data/quality-file.md",
      "/data/petrifilm-datasheet.md",
      "/data/quality-binder.md",
    ]) {
      expect(grouped, `${sourcePath} restates a fact but carries no factGroup`).toContain(
        sourcePath
      );
    }
  });

  it("leaves the EN/DE translation pair unmarked, and that is a decision, not an omission", () => {
    // The corpus header describes `vacation-policy-en.md` + `urlaub-policy-de.md`
    // as "a faithful EN/DE translation pair" — one fact in two documents, which
    // is the letter of what `factGroup` marks. It is deliberately NOT marked,
    // and this test is where the reason lives, because the next person to read
    // that header will reach for a factGroup and would be re-grading real runs.
    //
    // `dedup-inflation` charges an answer for presenting one fact as if two
    // sources had confirmed it independently. That charge rests on the reader
    // being unable to tell: nothing about `product-insert.md` and
    // `quality-file.md` announces that the second reworded the first, which is
    // why every model stacked them. A translation pair announces itself — in
    // the filenames, in the language of the text — and the sweep's answers show
    // the models handling it exactly that way: glm-5.2 writes "the same rule
    // appears in both the English and German policy documents", which is the
    // opposite of claiming two witnesses.
    //
    // Seven of the 48 published runs cite both, three of them as clean passes.
    // Marking this pair would fail all three for a defect they do not commit.
    const paired = nearDuplicatePathGroups().some(
      (group) =>
        group.includes("/data/vacation-policy-en.md") && group.includes("/data/urlaub-policy-de.md")
    );
    expect(paired).toBe(false);
  });

  it("marks only chunks that are in the corpus", () => {
    const paths = new Set(KB_EVAL_CORPUS.map((doc) => doc.sourcePath));
    for (const group of nearDuplicatePathGroups()) {
      for (const sourcePath of group) expect(paths).toContain(sourcePath);
    }
  });
});
