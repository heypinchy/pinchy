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
