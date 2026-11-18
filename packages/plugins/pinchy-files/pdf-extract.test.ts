// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import PDFDocument from "pdfkit";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  extractPdfText,
  isScannedPage,
  getImageObject,
  classifyPageImages,
  collectEmbeddedImages,
  remainingImageBudget,
  IMAGE_OBJECT_TIMEOUT_MS,
  type ImageLookup,
} from "./pdf-extract";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

/** Build a minimal single-page PDF in-memory with pdfkit. */
function buildPdf(
  build: (doc: PDFKit.PDFDocument) => void,
  size: [number, number]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size, margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

describe("isScannedPage — what happens when the page's images cannot be measured", () => {
  // pdfjs only resolves an image object through `page.objs.get(name, cb)`, which
  // has no promise and no deadline of its own, so pdf-extract wraps it in a
  // timeout. Measured on a loaded machine (load ~236) that callback took 14.0s
  // for a single 1200x1600 scan — nearly 3x the 5s the timeout used to allow.
  //
  // What made that a product bug rather than a slow test: on timeout the old
  // code fell through to `hasLargeImages = false`, so a sparse-text page that
  // paints a full-page image was classified as an ordinary text page. No render,
  // no OCR hand-off — the agent silently received a blank page for a scanned
  // invoice, with nothing anywhere saying a measurement had been dropped.
  //
  // So an unmeasurable image is now evidence FOR a scan, not against one. The
  // page already proved it paints an image; only the size check timed out.
  it("is a scan when a sparse page has a large image", () => {
    expect(isScannedPage({ sparseText: true, hasLargeImages: true, imageSizeUnknown: false })).toBe(
      true
    );
  });

  it("is a scan when a sparse page paints an image we could not measure in time", () => {
    expect(isScannedPage({ sparseText: true, hasLargeImages: false, imageSizeUnknown: true })).toBe(
      true
    );
  });

  it("is not a scan when a sparse page paints no image at all", () => {
    // imageSizeUnknown can only be set by an image that was actually painted, so
    // a page with no paint op reaches this with both flags false and stays text.
    expect(
      isScannedPage({ sparseText: false, hasLargeImages: false, imageSizeUnknown: false })
    ).toBe(false);
    expect(
      isScannedPage({ sparseText: true, hasLargeImages: false, imageSizeUnknown: false })
    ).toBe(false);
  });

  it("is never a scan when the page has plenty of text", () => {
    // A text-rich page with a big illustration is still a text page.
    expect(
      isScannedPage({ sparseText: false, hasLargeImages: true, imageSizeUnknown: false })
    ).toBe(false);
    expect(
      isScannedPage({ sparseText: false, hasLargeImages: false, imageSizeUnknown: true })
    ).toBe(false);
  });

  it("allows enough time for a real decode on a busy machine", () => {
    // The measured worst case was 14.0s. Anything at or below it turns a busy
    // machine back into silently degraded extraction, which is the whole defect.
    expect(IMAGE_OBJECT_TIMEOUT_MS).toBeGreaterThan(14_000);
  });
});

describe("getImageObject — telling 'pdfjs said no' apart from 'pdfjs said nothing'", () => {
  const anImage = { width: 1200, height: 1600, data: new Uint8ClampedArray(4) };

  it("resolves an image pdfjs hands back", async () => {
    const objs = { get: (_n: string, cb: (d: unknown) => void) => cb(anImage) };
    expect(await getImageObject(objs, "img0", 50)).toEqual({
      status: "resolved",
      image: anImage,
    });
  });

  it("reports unavailable when pdfjs answers with something that is not an image", async () => {
    const objs = { get: (_n: string, cb: (d: unknown) => void) => cb(null) };
    expect(await getImageObject(objs, "img0", 50)).toEqual({ status: "unavailable" });
  });

  it("reports unavailable when the lookup itself throws", async () => {
    const objs = {
      get: () => {
        throw new Error("not in the object store");
      },
    };
    expect(await getImageObject(objs, "img0", 50)).toEqual({ status: "unavailable" });
  });

  it("reports a timeout — never 'unavailable' — when pdfjs simply never answers", async () => {
    // This is the distinction the whole discriminated union exists for: an
    // unanswered lookup used to collapse into the same `null` as a genuine
    // "no such image", which is what silently reclassified scanned pages.
    const objs = { get: () => {} };
    expect(await getImageObject(objs, "img0", 20)).toEqual({ status: "timeout" });
  });

  it("still resolves a cached image once the page's budget is exhausted", async () => {
    // A zero budget must not blind us to images pdfjs already has in hand: it
    // answers synchronously for those, before the timer can fire.
    const objs = { get: (_n: string, cb: (d: unknown) => void) => cb(anImage) };
    expect(await getImageObject(objs, "img0", 0)).toEqual({
      status: "resolved",
      image: anImage,
    });
  });
});

describe("remainingImageBudget — one page cannot spend the timeout once per image", () => {
  // The timeout is per lookup, so without a per-page budget a page painting N
  // undecodable images waits N x 30s. Raising the per-image allowance from 5s to
  // 30s multiplied that worst case by six, which is why the budget exists.
  it("gives the first lookup on a page the full allowance", () => {
    expect(remainingImageBudget(0)).toBe(IMAGE_OBJECT_TIMEOUT_MS);
  });

  it("charges what earlier lookups on the same page already spent", () => {
    expect(remainingImageBudget(1_000)).toBe(IMAGE_OBJECT_TIMEOUT_MS - 1_000);
  });

  it("never goes negative once the page has spent its budget", () => {
    // A negative timeout would fire immediately in setTimeout, but it would also
    // read as "no limit" to anyone skimming the call site. Clamp it.
    expect(remainingImageBudget(IMAGE_OBJECT_TIMEOUT_MS)).toBe(0);
    expect(remainingImageBudget(IMAGE_OBJECT_TIMEOUT_MS + 60_000)).toBe(0);
  });
});

describe("the page — not the image — is the unit both scan paths bound", () => {
  // remainingImageBudget above is only arithmetic; these tests are about whether
  // the two loops that walk a page's paintImageXObject ops actually spend ONE
  // budget between them. Until they did, the budget bounded the embedded-image
  // loop alone, while the classification loop — the one that runs on every
  // sparse page of every document, up to DEFAULT_MAX_PAGES of them — still paid
  // the full per-lookup allowance per image. Raising that allowance 5s -> 30s
  // therefore multiplied the document-level worst case by six with nothing
  // capping it: 50 pages x 30s of pure waiting.
  //
  // Both functions take the operator list as an ARGUMENT on purpose. The budget
  // clock cannot start before `page.getOperatorList()` has resolved, so parsing
  // a heavy page's ops can no longer eat the allowance its images need.
  const smallImage = { width: 10, height: 10, data: new Uint8ClampedArray(4) };
  const largeImage = { width: 1200, height: 1600, data: new Uint8ClampedArray(4) };
  /** Never consulted: every test here injects `lookup` instead of hitting pdfjs. */
  const noImageStore = { get: () => {} };

  /** An operator list painting `count` images, with a non-image op in between. */
  function paintOps(count: number) {
    const fnArray: number[] = [];
    const argsArray: unknown[][] = [];
    for (let i = 0; i < count; i++) {
      fnArray.push(OPS.save);
      argsArray.push([]);
      fnArray.push(OPS.paintImageXObject);
      argsArray.push([`img${i}`]);
    }
    return { fnArray, argsArray };
  }

  /** A lookup that records the allowance it was handed and burns `costMs`. */
  function spendingLookup(costMs: number, result: ImageLookup) {
    const allowances: number[] = [];
    let clock = 0;
    return {
      allowances,
      now: () => clock,
      lookup: async (_objs: unknown, _name: string, timeoutMs: number) => {
        allowances.push(timeoutMs);
        clock += costMs;
        return result;
      },
    };
  }

  it("shrinks the classification allowance as the page spends it", async () => {
    const spy = spendingLookup(10_000, { status: "resolved", image: smallImage });
    await classifyPageImages(paintOps(4), noImageStore, {
      now: spy.now,
      lookup: spy.lookup,
    });
    // Four small images that each take 10s used to cost 4 x 30s of allowance;
    // they now share the page's single 30s and the last one gets nothing left.
    expect(spy.allowances).toEqual([30_000, 20_000, 10_000, 0]);
  });

  it("shrinks the embedded-image allowance the same way", async () => {
    const spy = spendingLookup(12_000, { status: "resolved", image: smallImage });
    await collectEmbeddedImages(paintOps(3), noImageStore, {
      now: spy.now,
      lookup: spy.lookup,
    });
    expect(spy.allowances).toEqual([30_000, 18_000, 6_000]);
  });

  it("stops classifying at the first large image", async () => {
    const spy = spendingLookup(0, { status: "resolved", image: largeImage });
    const verdict = await classifyPageImages(paintOps(5), noImageStore, {
      now: spy.now,
      lookup: spy.lookup,
    });
    expect(verdict).toEqual({ hasLargeImages: true, imageSizeUnknown: false });
    expect(spy.allowances).toHaveLength(1);
  });

  it("reports an unmeasurable image as a scan, and says so", async () => {
    const warnings: string[] = [];
    const spy = spendingLookup(0, { status: "timeout" });
    const verdict = await classifyPageImages(paintOps(3), noImageStore, {
      now: spy.now,
      lookup: spy.lookup,
      warn: (m) => warnings.push(m),
    });
    expect(verdict).toEqual({ hasLargeImages: false, imageSizeUnknown: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/scan/i);
  });

  it("stays text when every painted image is measurably small", async () => {
    const spy = spendingLookup(0, { status: "resolved", image: smallImage });
    expect(
      await classifyPageImages(paintOps(3), noImageStore, {
        now: spy.now,
        lookup: spy.lookup,
      })
    ).toEqual({ hasLargeImages: false, imageSizeUnknown: false });
  });

  it("collects the large images pdfjs did answer for and skips the rest", async () => {
    const answers: ImageLookup[] = [
      { status: "resolved", image: largeImage },
      { status: "unavailable" },
      { status: "timeout" },
      { status: "resolved", image: smallImage },
    ];
    let i = 0;
    const images = await collectEmbeddedImages(paintOps(4), noImageStore, {
      now: () => 0,
      lookup: async () => answers[i++],
      warn: () => {},
    });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ width: 1200, height: 1600 });
  });

  it("never claims a scan when it gives up on an embedded image", async () => {
    // This loop only runs for a page that is NOT sparse and NOT a scan, so the
    // classification wording would be actively false here: the image is dropped
    // and the page keeps its text. One warning per page, not one per image —
    // once the budget is spent every remaining lookup times out instantly, and a
    // 50-image page would otherwise emit 50 identical lines.
    const warnings: string[] = [];
    await collectEmbeddedImages(paintOps(6), noImageStore, {
      now: () => 0,
      lookup: async () => ({ status: "timeout" }) as ImageLookup,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(/scan/i);
  });

  it("says nothing when the whole page decoded in time", async () => {
    const warnings: string[] = [];
    await collectEmbeddedImages(paintOps(2), noImageStore, {
      now: () => 0,
      lookup: async () => ({ status: "resolved", image: largeImage }) as ImageLookup,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
  });

  it("leaves the interpretation of a timeout to its caller", async () => {
    // getImageObject is used by both loops, which draw opposite conclusions from
    // a timeout. A warning inside it can therefore only be right for one of them
    // — it used to announce "treating the page as a scan" to the loop that does
    // the exact opposite.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await getImageObject({ get: () => {} }, "img0", 10)).toEqual({
        status: "timeout",
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// Real fixtures, real pdfjs, real canvas rendering: a 60-page parse plus PNG
// rasterisation is genuinely seconds of CPU, and with IMAGE_OBJECT_TIMEOUT_MS
// now allowing a slow decode to finish, a single test can legitimately outlast
// vitest's default. The explicit timeout is headroom for slow work, not cover
// for a hang — every assertion below is unchanged.
describe("extractPdfText", { timeout: 180_000 }, () => {
  it("extracts text from a text-only PDF", async () => {
    const buffer = readFileSync(join(FIXTURES, "text-only.pdf"));
    const result = await extractPdfText(buffer);

    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    expect(result.pages[0].text.length).toBeGreaterThan(50);
    expect(result.totalPages).toBe(result.pages.length);
    // Check for key phrases from the golden file
    const expected = readFileSync(join(FIXTURES, "text-only.expected.txt"), "utf-8");
    for (const phrase of expected.split("\n").filter(Boolean)) {
      const fullText = result.pages.map((p) => p.text).join("\n");
      expect(fullText).toContain(phrase);
    }
  });

  it("marks pages with sparse text as scanned", async () => {
    const buffer = readFileSync(join(FIXTURES, "scanned.pdf"));
    const result = await extractPdfText(buffer);

    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.pages[0].isScanned).toBe(true);
    expect(result.pages[0].text.length).toBeLessThan(200);
  });

  it("renders scanned pages to PNG during extraction", async () => {
    const buffer = readFileSync(join(FIXTURES, "scanned.pdf"));
    const result = await extractPdfText(buffer);

    expect(result.pages[0].isScanned).toBe(true);
    expect(result.pages[0].renderedImage).toBeDefined();
    expect(result.pages[0].renderedImage!.length).toBeGreaterThan(100);
    // PNG magic bytes
    expect(result.pages[0].renderedImage![0]).toBe(0x89);
    expect(result.pages[0].renderedImage![1]).toBe(0x50);
    expect(result.pages[0].renderedImage![2]).toBe(0x4e);
    expect(result.pages[0].renderedImage![3]).toBe(0x47);
  });

  it("does not render non-scanned pages", async () => {
    const buffer = readFileSync(join(FIXTURES, "text-only.pdf"));
    const result = await extractPdfText(buffer);

    for (const page of result.pages) {
      expect(page.isScanned).toBe(false);
      expect(page.renderedImage).toBeUndefined();
    }
  });

  it("extracts table content", async () => {
    const buffer = readFileSync(join(FIXTURES, "with-tables.pdf"));
    const result = await extractPdfText(buffer);

    const fullText = result.pages.map((p) => p.text).join("\n");
    const expected = readFileSync(join(FIXTURES, "with-tables.expected.txt"), "utf-8");
    for (const phrase of expected.split("\n").filter(Boolean)) {
      expect(fullText).toContain(phrase);
    }
  });

  it("handles mixed PDFs — text and scanned pages", async () => {
    const buffer = readFileSync(join(FIXTURES, "mixed.pdf"));
    const result = await extractPdfText(buffer);

    // First pages should have text
    expect(result.pages[0].isScanned).toBe(false);
    expect(result.pages[0].text.length).toBeGreaterThan(50);

    // Last page should be scanned
    const lastPage = result.pages[result.pages.length - 1];
    expect(lastPage.isScanned).toBe(true);
  });

  it("detects embedded images above size threshold", async () => {
    const buffer = readFileSync(join(FIXTURES, "with-images.pdf"));
    const result = await extractPdfText(buffer);

    const pagesWithImages = result.pages.filter((p) => p.embeddedImages.length > 0);
    expect(pagesWithImages.length).toBeGreaterThanOrEqual(1);
    for (const page of pagesWithImages) {
      for (const img of page.embeddedImages) {
        expect(img.width).toBeGreaterThanOrEqual(100);
        expect(img.height).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it("respects page limit", async () => {
    const buffer = readFileSync(join(FIXTURES, "large-60pages.pdf"));
    const result = await extractPdfText(buffer, { maxPages: 50 });

    expect(result.pages.length).toBe(50);
    expect(result.totalPages).toBe(60);
    expect(result.truncated).toBe(true);
  });

  it("does not mark short text pages without images as scanned", async () => {
    // Create a minimal PDF with just "Hello" on one page — short text, no images.
    // With the old logic (text.length < 200 → scanned), this would be marked as scanned.
    // With the new logic, it should NOT be scanned because there are no large images.
    const buffer = await buildPdf(
      (doc) => {
        doc.fontSize(12).text("Hello", 50, 100);
      },
      [200, 200]
    );

    const result = await extractPdfText(buffer);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text.length).toBeLessThan(200); // confirms sparse text
    expect(result.pages[0].isScanned).toBe(false); // but NOT scanned (no images)
  });
});
