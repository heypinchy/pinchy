/**
 * The chunk locator is the anchor a citation points at. It is a CLOSED union
 * rather than a free-form string because Wave 2 adds one producer per format
 * (Office, spreadsheets) against it, and a stringly-typed anchor is exactly
 * what would let two of them drift apart — see #933.
 *
 * Only the `page` producer exists today (PDF ingest), so the other three kinds
 * are pinned here by their rendering alone. That is deliberate: the renderer is
 * the contract Wave 2 has to hit, and pinning it now means a later producer
 * cannot quietly invent a second spelling for the same anchor.
 */
import { describe, it, expect } from "vitest";

import { formatLocator, type ChunkLocator } from "@/lib/knowledge/locator";

describe("formatLocator", () => {
  it("renders a PDF page as the `p. N` form citations already use", () => {
    expect(formatLocator({ kind: "page", page: 12 })).toBe("p. 12");
  });

  it("renders a slide by its number, because slide N is intrinsic to the deck", () => {
    expect(formatLocator({ kind: "slide", slide: 4 })).toBe("slide 4");
  });

  it("renders a Word anchor as its heading path, never as a page", () => {
    // Word pagination is a RENDERING result (fonts, printer metrics, Word vs
    // LibreOffice), so a page number is not a property of the document the
    // reader opens. The heading path is.
    expect(formatLocator({ kind: "heading", headings: ["Quality", "Incoming goods"] })).toBe(
      "§ Quality > Incoming goods"
    );
  });

  it("renders a single-level heading path without a separator", () => {
    expect(formatLocator({ kind: "heading", headings: ["Scope"] })).toBe("§ Scope");
  });

  it("renders a spreadsheet anchor as its sheet and row range", () => {
    expect(formatLocator({ kind: "sheet", sheet: "Suppliers", startRow: 5, endRow: 12 })).toBe(
      "Suppliers, rows 5-12"
    );
  });

  it("renders a one-row spreadsheet anchor in the singular", () => {
    expect(formatLocator({ kind: "sheet", sheet: "Suppliers", startRow: 7, endRow: 7 })).toBe(
      "Suppliers, row 7"
    );
  });

  it("is exhaustive over the union — a new kind must not fall through to a bare string", () => {
    // Compile-time exhaustiveness is what actually enforces this (the switch
    // has no default), so this case only guards the runtime fallback a future
    // edit might add: every declared kind must render to something non-empty.
    const all: ChunkLocator[] = [
      { kind: "page", page: 1 },
      { kind: "slide", slide: 1 },
      { kind: "heading", headings: ["A"] },
      { kind: "sheet", sheet: "S", startRow: 1, endRow: 2 },
    ];
    for (const locator of all) {
      expect(formatLocator(locator).length).toBeGreaterThan(0);
    }
  });
});
