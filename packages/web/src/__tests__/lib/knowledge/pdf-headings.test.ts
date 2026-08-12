/**
 * Reading a Word document's outline back out of its converted PDF (#938).
 *
 * A Word document has no honest page number — pagination is a rendering result
 * (locator.ts says why) — so its citations are anchored on the heading path
 * instead. LibreOffice exports Word's outline as PDF bookmarks, for `.docx`
 * AND for legacy `.doc`, which is what makes ONE mechanism cover a corpus that
 * is two thirds legacy.
 *
 * ## Why a checked-in fixture, when the sibling test builds its PDFs with pdfkit
 *
 * Because pdfkit cannot produce the input this code exists to read. Its
 * outline items carry a `/Fit` destination — a page and nothing else — while
 * LibreOffice writes `/XYZ` with the heading's coordinates. That difference is
 * the entire problem: two headings routinely share one page (they do in this
 * fixture), so a page-only anchor would file the whole page under the LAST
 * heading on it and mis-anchor every chunk above it.
 *
 * So `word-headings.pdf` is real LibreOffice output, committed next to the
 * `word-headings.fodt` it was made from. To regenerate:
 *
 *   soffice --headless --convert-to pdf word-headings.fodt --outdir .
 *
 * It is deliberately shaped to hold all three cases at once: two headings on
 * page 1, a third on page 2, and a page-2 top that still belongs to the
 * section that started on page 1.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { extractPdfPages } from "@/lib/knowledge/pdf-extract";

const FIXTURE = join(__dirname, "../../fixtures/kb/word-headings.pdf");

describe("extractPdfPages with the outline", () => {
  it("reads the heading paths, outermost first", async () => {
    const pages = await extractPdfPages(FIXTURE, { outline: true });

    const paths = pages.flatMap((page) => page.headings ?? []).map((mark) => mark.headings);
    expect(paths).toEqual([
      ["Quality management"],
      ["Quality management", "Incoming goods"],
      ["Safety rules"],
    ]);
  });

  it("anchors a heading where its text starts, not at the top of its page", async () => {
    // The case pdfkit cannot express and the reason this fixture is real
    // LibreOffice output: page 1 carries two headings, so a page-level anchor
    // would put the text under "Quality management" into "Incoming goods".
    const [firstPage] = await extractPdfPages(FIXTURE, { outline: true });

    const marks = firstPage.headings ?? [];
    expect(marks).toHaveLength(2);
    expect(marks[0].charStart).toBe(0);
    expect(marks[1].charStart).toBeGreaterThan(0);

    // The heading's own text is where its section begins.
    expect(firstPage.text.slice(marks[1].charStart)).toMatch(/^Incoming goods/);
  });

  it("leaves the text itself untouched", async () => {
    // The marks are offsets INTO the page text, so asking for the outline must
    // not change a single character of what gets indexed — otherwise every
    // offset the caller computes against a plain extraction is wrong.
    const withOutline = await extractPdfPages(FIXTURE, { outline: true });
    const without = await extractPdfPages(FIXTURE);

    expect(withOutline.map((page) => page.text)).toEqual(without.map((page) => page.text));
    expect(without.every((page) => page.headings === undefined)).toBe(true);
  });

  it("reports no marks for a page whose text continues an earlier section", async () => {
    // Page 2 opens mid-section. It gets no mark of its own; carrying
    // "Incoming goods" across the page break is the caller's job, and a
    // fabricated mark here would claim the section STARTS on page 2.
    const pages = await extractPdfPages(FIXTURE, { outline: true });

    expect(pages).toHaveLength(2);
    expect(pages[1].headings?.map((mark) => mark.headings)).toEqual([["Safety rules"]]);
    expect(pages[1].headings?.[0].charStart).toBeGreaterThan(0);
  });
});
