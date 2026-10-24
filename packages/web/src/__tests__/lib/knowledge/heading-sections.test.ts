/**
 * Turning a converted Word document's heading marks into the anchor one chunk
 * carries (#938).
 *
 * The marks say where each section STARTS. Everything after a mark and before
 * the next one belongs to it — across page boundaries, which is the case a
 * per-page reading gets wrong: a section that starts at the bottom of page 3
 * owns the whole of page 4.
 */
import { describe, expect, it } from "vitest";

import { collectHeadingSections, headingLocatorAt } from "@/lib/knowledge/heading-sections";
import type { IngestPage } from "@/lib/knowledge/types";

const PAGES: IngestPage[] = [
  {
    page: 1,
    text: "Quality management\nIntro to quality.\nIncoming goods\nDeliveries are checked.",
    headings: [
      { charStart: 0, headings: ["Quality management"] },
      { charStart: 37, headings: ["Quality management", "Incoming goods"] },
    ],
  },
  // No mark of its own: this page continues the section that started on page 1.
  { page: 2, text: "Storage follows inspection." },
  {
    page: 3,
    text: "Still incoming goods.\nSafety rules\nHelmets are mandatory.",
    headings: [{ charStart: 22, headings: ["Safety rules"] }],
  },
];

const sections = collectHeadingSections(PAGES);

describe("collectHeadingSections", () => {
  it("flattens the per-page marks into document order", () => {
    expect(sections.map((section) => [section.page, section.charStart])).toEqual([
      [1, 0],
      [1, 37],
      [3, 22],
    ]);
  });
});

describe("headingLocatorAt", () => {
  it("anchors a chunk on the section it starts in", () => {
    expect(headingLocatorAt(sections, 1, 0)).toEqual({
      kind: "heading",
      headings: ["Quality management"],
    });
    expect(headingLocatorAt(sections, 1, 37)).toEqual({
      kind: "heading",
      headings: ["Quality management", "Incoming goods"],
    });
  });

  it("carries the section across a page break", () => {
    // Page 2 holds no heading at all. Its text is still part of "Incoming
    // goods", and a per-page reading would leave it unanchored.
    expect(headingLocatorAt(sections, 2, 0)).toEqual({
      kind: "heading",
      headings: ["Quality management", "Incoming goods"],
    });
  });

  it("keeps the earlier section for text above a heading on the same page", () => {
    // The failure a page-level anchor makes on every page that opens a new
    // section: the text ABOVE the heading belongs to the previous one.
    expect(headingLocatorAt(sections, 3, 0)).toEqual({
      kind: "heading",
      headings: ["Quality management", "Incoming goods"],
    });
    expect(headingLocatorAt(sections, 3, 22)).toEqual({
      kind: "heading",
      headings: ["Safety rules"],
    });
  });

  it("has no anchor for text before the first heading", () => {
    // A title page, or a document written without heading styles. #938 says
    // it plainly: no locator beats one that does not match what the reader
    // sees in Word.
    const late = collectHeadingSections([
      { page: 1, text: "Cover page." },
      { page: 2, text: "Body", headings: [{ charStart: 0, headings: ["Body"] }] },
    ]);

    expect(headingLocatorAt(late, 1, 0)).toBeNull();
    expect(headingLocatorAt([], 1, 0)).toBeNull();
  });
});
