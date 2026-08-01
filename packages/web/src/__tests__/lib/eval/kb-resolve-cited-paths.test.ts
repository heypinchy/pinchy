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

import { resolveCitedSourcePaths } from "../../../../eval/kb/resolve-cited-paths";

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
