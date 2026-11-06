/**
 * The pdf.js seam behind the citation viewer (#1268), with pdf.js replaced by a
 * fake whose timing the test controls. What it pins is what the real library
 * punishes: two renders on one canvas throw, so a page change that overtakes a
 * slow page must never start the stale render; and every run's box must cover
 * the run, including on a rotated page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "", workerPort: null as unknown },
  getDocument: vi.fn(),
  Util: {
    // The real affine product, so geometry is computed as pdf.js would.
    transform: (m1: number[], m2: number[]) => [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ],
  },
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdfjs);

import { openPdf, runRect } from "@/lib/pdf/browser-pdf";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakePage(
  textItems: unknown[] = [{ str: "Hallo", width: 50, transform: [10, 0, 0, 10, 72, 700] }]
) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      scale,
      // A page 800 units tall, y flipped, scaled.
      transform: [scale, 0, 0, -scale, 0, 800 * scale],
    }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: vi.fn(async () => ({ items: textItems })),
    cleanup: vi.fn(),
  };
}

const canvas = () => ({ width: 0, height: 0, style: {} }) as unknown as HTMLCanvasElement;

function documentWith(getPage: (n: number) => Promise<unknown>) {
  pdfjs.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 9, getPage: vi.fn(getPage) }),
    destroy: vi.fn(async () => {}),
  });
}

beforeEach(() => {
  pdfjs.getDocument.mockReset();
});

describe("openPdf", () => {
  it("lets pdf.js own the worker, so a worker that fails to load falls back instead of hanging", async () => {
    // A `workerPort` handed in from outside gets no error handling in pdf.js:
    // a worker that never loads leaves the document promise pending forever.
    documentWith(async () => fakePage());
    await openPdf("/doc.pdf");

    expect(pdfjs.GlobalWorkerOptions.workerSrc).toMatch(/pdf\.worker\.min\.mjs/);
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBeNull();
  });

  it("never starts a render a later page change has overtaken", async () => {
    const slow = deferred<ReturnType<typeof fakePage>>();
    const page5 = fakePage();
    const page4 = fakePage();
    documentWith((n) => (n === 5 ? slow.promise : Promise.resolve(page4)));
    const pdf = await openPdf("/doc.pdf");
    const target = canvas();

    // Next (page 5, not fetched yet), then Previous before it arrives.
    const stale = pdf.renderPage(5, target, 600);
    const fresh = await pdf.renderPage(4, target, 600);
    slow.resolve(page5);

    await expect(stale).rejects.toMatchObject({ name: "RenderingCancelledException" });
    expect(page5.render).not.toHaveBeenCalled();
    expect(page4.render).toHaveBeenCalledTimes(1);
    expect(fresh.runs).toHaveLength(1);
  });

  it("still shows a page whose text cannot be read, just without runs to highlight", async () => {
    const page = fakePage();
    page.getTextContent.mockRejectedValueOnce(new Error("bad font"));
    documentWith(async () => page);
    const pdf = await openPdf("/doc.pdf");

    const rendered = await pdf.renderPage(1, canvas(), 600);

    expect(rendered.runs).toEqual([]);
  });

  it("releases a page's decoded data once it is drawn", async () => {
    const page = fakePage();
    documentWith(async () => page);
    const pdf = await openPdf("/doc.pdf");

    await pdf.renderPage(1, canvas(), 600);

    expect(page.cleanup).toHaveBeenCalled();
  });

  it("places a run's box on the run, measured from the page top", async () => {
    documentWith(async () => fakePage());
    const pdf = await openPdf("/doc.pdf");

    // Scale 1: the run's baseline is 700 units up an 800-unit page, 10 tall.
    const { runs } = await pdf.renderPage(1, canvas(), 600);

    expect(runs[0].rect).toEqual({ left: 72, top: 90, width: 50, height: 10 });
  });
});

describe("runRect", () => {
  it("boxes horizontal text from its baseline up", () => {
    // Viewport-space transform of a 10-unit run at (72, 100), y down.
    expect(runRect([10, 0, 0, -10, 72, 100], 50)).toEqual({
      left: 72,
      top: 90,
      width: 50,
      height: 10,
    });
  });

  it("boxes text rotated a quarter turn, as on a /Rotate 90 page", () => {
    // Baseline runs straight down the screen; the glyphs' up points right.
    expect(runRect([0, 10, 10, 0, 200, 100], 50)).toEqual({
      left: 200,
      top: 100,
      width: 10,
      height: 50,
    });
  });
});
