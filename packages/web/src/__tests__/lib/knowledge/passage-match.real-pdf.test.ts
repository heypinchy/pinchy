/**
 * The premise the citation highlight rests on (#1268), checked against the
 * REAL extractor and chunker rather than asserted in a comment: every chunk the
 * index builds from a PDF page can be found again among that page's pdf.js
 * text runs — the runs the browser's renderer reads.
 *
 * If pdf-extract.ts ever starts normalising text in a way that is more than
 * whitespace (dehyphenation, ligature folding, reordering), chunks stop
 * matching the text layer and highlights silently disappear. This is the test
 * that turns red instead.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { chunkPages } from "@/lib/knowledge/chunk";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import { locatePassage } from "@/lib/knowledge/passage-match";

const FIXTURES = [
  join(__dirname, "../../../../../../sample-data/sample-product-handbook.pdf"),
  join(__dirname, "../../fixtures/kb/word-headings.pdf"),
];

async function textRunsByPage(path: string): Promise<Map<number, string[]>> {
  const task = getDocument({ data: new Uint8Array(await readFile(path)) });
  const doc = await task.promise;
  const byPage = new Map<number, string[]>();
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      byPage.set(
        n,
        content.items.flatMap((item) => ("str" in item ? [item.str] : []))
      );
    }
  } finally {
    await task.destroy();
  }
  return byPage;
}

const strip = (s: string) => s.replace(/\s+/g, "");

describe.each(FIXTURES)("every indexed chunk of %s is found on its page", (path) => {
  it("at the default chunk size and at a small one that starts chunks mid-page", async () => {
    const pages = await extractPdfPages(path);
    const runs = await textRunsByPage(path);

    let checked = 0;
    for (const targetTokens of [512, 40]) {
      for (const chunk of chunkPages(pages, { targetTokens })) {
        if (strip(chunk.text).length < 12) continue;
        const pageRuns = runs.get(chunk.page)!;
        const found = locatePassage(pageRuns, chunk.text);
        expect(found, `page ${chunk.page}: ${chunk.text.slice(0, 60)}`).not.toBeNull();
        expect(strip(found!.map((i) => pageRuns[i]).join(""))).toContain(strip(chunk.text));
        checked++;
      }
    }
    // A fixture that yields nothing would pass this vacuously.
    expect(checked).toBeGreaterThan(3);
  });
});
