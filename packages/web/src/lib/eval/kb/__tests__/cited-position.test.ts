/**
 * The Sources-entry position parser, pinned against what `formatLocator`
 * actually emits.
 *
 * `parseCitedPosition` splits `<path> (p. 12)` into the document a citation
 * names and the position inside it. The round-trip tests below are the reason
 * this module exists as its own file: they take a locator, render it exactly as
 * the `pinchy-knowledge` tool renders it, parse it back, and require the two to
 * be equal. A new `ChunkLocator` kind then cannot be added without either
 * teaching this parser or failing here — and because `SAMPLES` is a mapped type
 * over the union, forgetting the sample itself is a compile error, which
 * `tsconfig.typecheck.json` turns into a CI failure rather than a silent gap.
 */
import { describe, expect, it } from "vitest";

import { formatLocator, type ChunkLocator } from "@/lib/knowledge/locator";

import { parseCitedPosition } from "../cited-position";

/**
 * One representative locator per kind. The mapped type is load-bearing: add a
 * fifth kind to `ChunkLocator` and this object stops compiling until it carries
 * a sample, so the round-trip pins below can never quietly cover three of four.
 */
const SAMPLES: { [K in ChunkLocator["kind"]]: Extract<ChunkLocator, { kind: K }> } = {
  page: { kind: "page", page: 12 },
  slide: { kind: "slide", slide: 4 },
  heading: { kind: "heading", headings: ["Quality", "Incoming goods"] },
  sheet: { kind: "sheet", sheet: "Suppliers", startRow: 5, endRow: 12 },
};

const EVERY_KIND = Object.values(SAMPLES);

describe("parseCitedPosition", () => {
  describe("round-trips every shape formatLocator emits", () => {
    // The parenthesised form is what the tool prints and what the citation
    // contract asks the model to repeat "exactly as written above", so this is
    // the shape a well-behaved answer really carries.
    it.each(EVERY_KIND)("parenthesised: $kind", (locator) => {
      const parsed = parseCitedPosition(`quality-file.md (${formatLocator(locator)})`);

      expect(parsed.path).toBe("quality-file.md");
      expect(parsed.locator).toEqual(locator);
    });

    it.each(EVERY_KIND.filter((l) => l.kind !== "sheet"))("em-dashed: $kind", (locator) => {
      const parsed = parseCitedPosition(`quality-file.md — ${formatLocator(locator)}`);

      expect(parsed.path).toBe("quality-file.md");
      expect(parsed.locator).toEqual(locator);
    });

    // The tool's full line: position in parentheses, passage after it. Pinned
    // per kind for the same reason as the two above — a fifth kind must not
    // arrive readable only when it happens to end the entry.
    it.each(EVERY_KIND)("parenthesised, with the passage after it: $kind", (locator) => {
      const parsed = parseCitedPosition(
        `quality-file.md (${formatLocator(locator)}): "the passage"`
      );

      expect(parsed.path).toBe('quality-file.md: "the passage"');
      expect(parsed.locator).toEqual(locator);
    });
  });

  it("reads the en dash and the plain hyphen too, as the page form always has", () => {
    // `gpt-oss:120b` writes U+2013 where the template writes U+2014. A
    // separator delimits, it does not identify — same line `PAGE_SUFFIX` and
    // the product's own `TRAILING_PAGE` already drew.
    for (const dash of ["—", "–", "-"]) {
      expect(parseCitedPosition(`a.md ${dash} p. 3`)).toEqual({
        path: "a.md",
        locator: { kind: "page", page: 3 },
      });
    }
  });

  it("keeps a hyphen inside the path out of the split", () => {
    // The failure the `p.` literal has always prevented: `handbook-2012` must
    // not be read as `handbook` plus a position of `2012/policy.md — p. 12`.
    expect(parseCitedPosition("handbook-2012/policy.md — p. 12")).toEqual({
      path: "handbook-2012/policy.md",
      locator: { kind: "page", page: 12 },
    });
  });

  it("keeps a hyphen inside a sheet name out of the split", () => {
    expect(parseCitedPosition("suppliers.xlsx (Sheet-A, rows 3-4)")).toEqual({
      path: "suppliers.xlsx",
      locator: { kind: "sheet", sheet: "Sheet-A", startRow: 3, endRow: 4 },
    });
  });

  it("reads a single-row sheet range, the other branch formatLocator has", () => {
    expect(parseCitedPosition("suppliers.xlsx (Suppliers, row 5)")).toEqual({
      path: "suppliers.xlsx",
      locator: { kind: "sheet", sheet: "Suppliers", startRow: 5, endRow: 5 },
    });
  });

  it("reads a page range, keeping the first page as the anchor", () => {
    expect(parseCitedPosition("a.md — pp. 12-14")).toEqual({
      path: "a.md",
      locator: { kind: "page", page: 12 },
    });
  });

  it("reads a single-level heading path", () => {
    expect(parseCitedPosition("report.docx (§ Quality)")).toEqual({
      path: "report.docx",
      locator: { kind: "heading", headings: ["Quality"] },
    });
  });

  describe("reads a position the entry continues past", () => {
    // The tool prints `[1] quality-file.md (p. 1): "…"` — the position is
    // FOLLOWED by the passage, and a model repeating the line "exactly as
    // written above" carries all of it. Measured on the 2026-08-05 sweep: 22 of
    // 98 Sources entries repeat that rendering, and 12 of those 22 keep text
    // after the position. An end-anchored read sees a position on 10 of 22 —
    // and a 10 that means "not asked" for the other 12 is the shape #1181 spent
    // two defects correcting.
    it("reads the tool's own rendering: position, colon, quoted passage", () => {
      expect(parseCitedPosition('it-equipment-policy.md (p. 3): "Northwind issues …"')).toEqual({
        path: 'it-equipment-policy.md: "Northwind issues …"',
        locator: { kind: "page", page: 3 },
      });
    });

    it("reads it when a dash and a gloss follow instead", () => {
      // The other half of the 12: `gpt-oss:120b` writes the passage behind an
      // en dash rather than a colon.
      expect(parseCitedPosition('quality-file.md (p. 3) – "Per the specification …"')).toEqual({
        path: 'quality-file.md – "Per the specification …"',
        locator: { kind: "page", page: 3 },
      });
    });

    it("hands the rest back joined to the path, so the document still resolves", () => {
      // `matchRetrievedDocument` scans whatever it is given, and the trailing
      // passage is where a second, real path can appear. Dropping it here would
      // narrow a hole `cited-path-match.ts` documents as deliberately open —
      // a change of grading behaviour smuggled in as a parser fix.
      expect(parseCitedPosition("fabricated.md (p. 3): see handbook-2012/policy.md").path).toBe(
        "fabricated.md: see handbook-2012/policy.md"
      );
    });

    it("still closes on the OUTER parenthesis when the position ends the entry", () => {
      // A Word heading may carry parentheses of its own. The end-anchored
      // spelling is tried first for exactly this reason: reading trailing text
      // first would close at the inner `)` and hand back `report.docx)`.
      expect(parseCitedPosition("report.docx (§ Quality (2012 revision))")).toEqual({
        path: "report.docx",
        locator: { kind: "heading", headings: ["Quality (2012 revision)"] },
      });
    });

    it("leaves the DASHED spelling end-anchored", () => {
      // A stated bound. A parenthesis closes; a dash does not, so there is
      // nothing to prove where a position behind a dash ends — and reading one
      // mid-entry is how the AOAC title below would start parsing.
      const entry = "a.md — p. 3 of the printed annex";

      expect(parseCitedPosition(entry)).toEqual({ path: entry, locator: null });
    });
  });

  describe("leaves alone what is not a position", () => {
    it("does not strip an embellishing gloss after a dash", () => {
      // THE trap this parser is written around. Widening the split to "any
      // dash-space separator" would consume this title as if it were a
      // position — and `gradePathCitation` fails this shape today, on evidence
      // committed in packages/web/eval/data. A parser change must not move a
      // published number.
      const entry = "a/study.pdf – AOAC Performance Tested Method Study";

      expect(parseCitedPosition(entry)).toEqual({ path: entry, locator: null });
    });

    it("does not strip a parenthesised gloss that is not a locator shape", () => {
      const entry = "a/study.pdf (second edition)";

      expect(parseCitedPosition(entry)).toEqual({ path: entry, locator: null });
    });

    it("does not strip the `(undefined)` the published sweep really contains", () => {
      // Every 2026-08-05 answer that repeated the tool's rendering carries
      // this, from a chunk whose locator was undefined. It is not a position,
      // and treating it as one would rewrite `entry.path` under a committed
      // dataset.
      const entry = "quality-file.md (undefined)";

      expect(parseCitedPosition(entry)).toEqual({ path: entry, locator: null });
    });

    it("returns the whole entry when there is no position at all", () => {
      expect(parseCitedPosition("it-equipment-policy.md")).toEqual({
        path: "it-equipment-policy.md",
        locator: null,
      });
    });

    it("does not split a sheet range behind a plain hyphen", () => {
      // A deliberate, stated bound. A sheet name is free text, so unlike
      // `p.`/`slide`/`§` there is no literal at the boundary to prove the
      // hyphen is a separator rather than part of a path. Em and en dash are
      // accepted; a plain hyphen is not, and the entry stays whole — which
      // costs nothing, because `matchRetrievedDocument` scans the whole entry
      // and still resolves the document.
      const entry = "suppliers.xlsx - Suppliers, rows 5-12";

      expect(parseCitedPosition(entry)).toEqual({ path: entry, locator: null });
    });
  });

  it("trims the path it hands back", () => {
    expect(parseCitedPosition("  a.md   (p. 2)  ").path).toBe("a.md");
  });
});
