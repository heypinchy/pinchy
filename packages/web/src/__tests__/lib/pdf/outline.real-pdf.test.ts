/**
 * The premise the Office citation highlight rests on (#1268, Office addendum),
 * checked against the REAL indexer rather than asserted in a comment: every
 * chunk the ingest files under a Word heading is found again by the viewer's
 * route — resolve the heading through the PDF's outline, scan that section's
 * pages — on the very page it was cut from.
 *
 * `word-headings.pdf` is real LibreOffice output (see pdf-headings.test.ts for
 * why pdfkit cannot stand in): two headings share page 1, and the top of
 * page 2 still belongs to the section that started on page 1.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { chunkPages } from "@/lib/knowledge/chunk";
import { collectHeadingSections, headingLocatorAt } from "@/lib/knowledge/heading-sections";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import { locatePassage } from "@/lib/knowledge/passage-match";
import { findSectionPage, flattenOutline, joinHeadings, sectionPages } from "@/lib/pdf/outline";

const FIXTURE = join(__dirname, "../../fixtures/kb/word-headings.pdf");

describe("a Word chunk is found through the outline on the page it came from", () => {
  it("at the default chunk size and at a small one that starts chunks mid-page", async () => {
    const pages = await extractPdfPages(FIXTURE, { outline: true });
    const sections = collectHeadingSections(pages);

    const task = getDocument({ data: new Uint8Array(await readFile(FIXTURE)) });
    const doc = await task.promise;
    try {
      const outline = await flattenOutline(doc);
      const viewerPages = {
        async pageRuns(n: number) {
          const content = await (await doc.getPage(n)).getTextContent();
          return content.items.flatMap((item) => ("str" in item ? [item.str] : []));
        },
      };

      let unique = 0;
      for (const targetTokens of [512, 40]) {
        for (const chunk of chunkPages(pages, { targetTokens })) {
          const locator = headingLocatorAt(sections, chunk.page, chunk.charStart);
          if (locator?.kind !== "heading" || chunk.text.replace(/\s+/g, "").length < 12) continue;
          const label = `${joinHeadings(locator.headings)}, page ${chunk.page}: ${chunk.text.slice(0, 60)}`;

          const range = sectionPages(outline, joinHeadings(locator.headings), doc.numPages);
          expect(range, label).not.toBeNull();
          const found = await findSectionPage(viewerPages, range!, chunk.text);

          // The fixture is filler text, so a small chunk can recur word for
          // word on an earlier page of its section. The scan then lands on the
          // first occurrence — the same rule `locatePassage` applies within a
          // page. A chunk that occurs once must land exactly where it was cut.
          const holding: number[] = [];
          for (let n = range!.first; n <= range!.last; n++) {
            if (locatePassage(await viewerPages.pageRuns(n), chunk.text)) holding.push(n);
          }
          expect(holding, label).toContain(chunk.page);
          expect(found, label).toBe(holding[0]);
          if (holding.length === 1) unique++;
        }
      }
      // A fixture that yields nothing would pass this vacuously; and the
      // default chunk size must give real, unambiguous coverage, including
      // page 2's top, which belongs to a section that started on page 1.
      expect(unique).toBeGreaterThan(3);
    } finally {
      await task.destroy();
    }
  });
});
