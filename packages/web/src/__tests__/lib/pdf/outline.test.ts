/**
 * The outline of a converted Word document, read the same way by the indexer
 * and by the citation viewer (#1268, Office addendum). The index files a Word
 * chunk under a heading path read from the PDF's bookmarks; the viewer turns
 * that path back into the pages the chunk can sit on.
 */
import { describe, expect, it, vi } from "vitest";

import {
  findSectionPage,
  flattenOutline,
  joinHeadings,
  MAX_SECTION_SCAN_PAGES,
  sectionPages,
  type OutlineEntry,
} from "@/lib/pdf/outline";

interface Node {
  title?: string;
  dest?: string | unknown[] | null;
  items?: Node[];
}

/** A document whose destination arrays name their page index as `{ index }`. */
function fakeDoc(outline: Node[] | null, named: Record<string, unknown[]> = {}) {
  return {
    getOutline: vi.fn(async () => outline),
    getDestination: vi.fn(async (id: string) => named[id] ?? null),
    getPageIndex: vi.fn(async (ref: never) => {
      const index = (ref as { index?: number }).index;
      if (index === undefined) throw new Error("bad ref");
      return index;
    }),
  };
}

const xyz = (index: number, top: number) => [{ index }, { name: "XYZ" }, 0, top, 0];
const fit = (index: number) => [{ index }, { name: "Fit" }];

describe("flattenOutline", () => {
  it("returns one entry per heading in document order, outermost first", async () => {
    const doc = fakeDoc(
      [
        {
          title: " Quality ",
          dest: xyz(0, 700),
          items: [{ title: "Incoming goods", dest: "ig" }],
        },
        { title: "Safety", dest: fit(2) },
      ],
      { ig: xyz(1, 500) }
    );

    expect(await flattenOutline(doc)).toEqual([
      { page: 1, top: 700, headings: ["Quality"] },
      { page: 2, top: 500, headings: ["Quality", "Incoming goods"] },
      { page: 3, top: null, headings: ["Safety"] },
    ]);
  });

  it("lets an untitled entry add no level, and skips one with no heading at all", async () => {
    const doc = fakeDoc([{ title: "", dest: fit(0), items: [{ title: "Zone B", dest: fit(1) }] }]);

    expect(await flattenOutline(doc)).toEqual([{ page: 2, top: null, headings: ["Zone B"] }]);
  });

  it("drops an entry whose destination does not resolve and keeps the rest", async () => {
    const doc = fakeDoc([
      { title: "Broken", dest: [{}] },
      { title: "Missing", dest: "nowhere" },
      { title: "Fine", dest: fit(3) },
    ]);

    expect(await flattenOutline(doc)).toEqual([{ page: 4, top: null, headings: ["Fine"] }]);
  });

  it("reads an outline it cannot read as none", async () => {
    const doc = fakeDoc(null);
    doc.getOutline.mockRejectedValueOnce(new Error("corrupt"));

    expect(await flattenOutline(doc)).toEqual([]);
    expect(await flattenOutline(fakeDoc(null))).toEqual([]);
  });
});

describe("joinHeadings", () => {
  it("spells a heading path the way a citation shows it", () => {
    expect(joinHeadings(["Quality", "Incoming goods"])).toBe("Quality > Incoming goods");
  });
});

const entry = (page: number, ...headings: string[]): OutlineEntry => ({
  page,
  top: null,
  headings,
});

describe("sectionPages", () => {
  const outline = [entry(1, "Quality"), entry(1, "Quality", "Incoming goods"), entry(4, "Safety")];

  it("runs from the section's page to the page the next entry starts on", () => {
    // The next entry may start mid-page, so its page still holds this section.
    expect(sectionPages(outline, "Quality > Incoming goods", 9)).toEqual({ first: 1, last: 4 });
  });

  it("ends on its own page when the next entry starts there too", () => {
    expect(sectionPages(outline, "Quality", 9)).toEqual({ first: 1, last: 1 });
  });

  it("runs to the end of the document for the last entry", () => {
    expect(sectionPages(outline, "Safety", 9)).toEqual({ first: 4, last: 9 });
  });

  it("never runs backwards when the outline is out of page order", () => {
    expect(sectionPages([entry(5, "B"), entry(2, "A")], "B", 9)).toEqual({ first: 5, last: 5 });
  });

  it("answers null for a heading the outline does not have", () => {
    expect(sectionPages(outline, "Quality > Outgoing goods", 9)).toBeNull();
    // A parent is not a match for its child, nor the other way round.
    expect(sectionPages(outline, "Incoming goods", 9)).toBeNull();
  });
});

describe("findSectionPage", () => {
  const passage = "Incoming goods are checked within 24 hours of arrival";

  function pagesWith(byPage: Record<number, string[]>) {
    return { pageRuns: vi.fn(async (n: number) => byPage[n] ?? []) };
  }

  it("returns the first page of the section that holds the passage", async () => {
    const pages = pagesWith({ 3: ["Incoming goods are checked", "within 24 hours of arrival"] });

    expect(await findSectionPage(pages, { first: 2, last: 4 }, passage)).toBe(3);
    // It stops once found.
    expect(pages.pageRuns.mock.calls.map(([n]) => n)).toEqual([2, 3]);
  });

  it("returns the section's first page when the passage is not in it", async () => {
    const pages = pagesWith({ 9: [passage] });

    expect(await findSectionPage(pages, { first: 2, last: 4 }, passage)).toBe(2);
  });

  it("does not scan at all without a passage", async () => {
    const pages = pagesWith({});

    expect(await findSectionPage(pages, { first: 2, last: 4 }, null)).toBe(2);
    expect(pages.pageRuns).not.toHaveBeenCalled();
  });

  it("scans no more than the cap, however long the section", async () => {
    const pages = pagesWith({ [2 + MAX_SECTION_SCAN_PAGES]: [passage] });

    expect(await findSectionPage(pages, { first: 2, last: 500 }, passage)).toBe(2);
    expect(pages.pageRuns).toHaveBeenCalledTimes(MAX_SECTION_SCAN_PAGES);
  });

  it("skips a page whose text cannot be read", async () => {
    const pages = {
      pageRuns: vi.fn(async (n: number) => {
        if (n === 2) throw new Error("unreadable");
        return n === 3 ? [passage] : [];
      }),
    };

    expect(await findSectionPage(pages, { first: 2, last: 3 }, passage)).toBe(3);
  });
});
