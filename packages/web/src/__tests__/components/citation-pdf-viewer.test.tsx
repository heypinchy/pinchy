// @vitest-environment jsdom
/**
 * The viewer a knowledge-base page citation opens into (#1268): the cited page,
 * drawn by pdf.js, with the passage the answer drew on highlighted.
 *
 * pdf.js itself is replaced — jsdom has neither canvas nor workers. What these
 * tests pin is the contract around it: which page is drawn, which runs are
 * highlighted for which passage, and that every failure leaves the reader with
 * the document rather than an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { jsonResponse } from "@/test-helpers/fetch";
import type { RenderedPdfPage } from "@/lib/pdf/browser-pdf";

const mockOpenPdf = vi.fn();
vi.mock("@/lib/pdf/browser-pdf", () => ({
  openPdf: (...args: unknown[]) => mockOpenPdf(...args),
}));

import { CitationPdfViewer } from "@/components/assistant-ui/citation-pdf-viewer";

const run = (str: string, top: number) => ({
  str,
  rect: { left: 10, top, width: 200, height: 12 },
});

const PAGE_4: RenderedPdfPage = {
  width: 600,
  height: 800,
  runs: [
    run("§ 4 Reaktionszeiten", 100),
    run("Der Auftragnehmer reagiert auf Störungen", 120),
    run("innerhalb von vier Stunden.", 140),
    run("§ 5 Vergütung", 160),
  ],
};

function handle(pages = 12) {
  return {
    numPages: pages,
    renderPage: vi.fn(async (_page: number, _canvas: unknown, _width: number) => PAGE_4),
    destroy: vi.fn(),
  };
}

const DOC_URL = "/api/agents/a1/workspace-file/Wartung.pdf?path=%2Fdata%2Fq%2FWartung.pdf#page=4";
const PASSAGE = {
  url: "/api/agents/a1/knowledge/passage",
  body: { path: "/data/q/Wartung.pdf", page: 4, claim: "Four hours." },
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockOpenPdf.mockReset();
  fetchSpy = vi.spyOn(global, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function renderViewer(passage: typeof PASSAGE | null = PASSAGE) {
  return render(
    <CitationPdfViewer
      url={DOC_URL}
      page={4}
      passage={passage}
      fallback={<div data-testid="browser-viewer" />}
    />
  );
}

const highlights = () => document.querySelectorAll("[data-passage-highlight]");

describe("CitationPdfViewer", () => {
  it("draws the cited page of the document, fetched without its fragment", async () => {
    const pdf = handle();
    mockOpenPdf.mockResolvedValue(pdf);
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalled());
    expect(mockOpenPdf).toHaveBeenCalledWith(
      "/api/agents/a1/workspace-file/Wartung.pdf?path=%2Fdata%2Fq%2FWartung.pdf"
    );
    expect(pdf.renderPage.mock.calls[0][0]).toBe(4);
    expect(await screen.findByText("Page 4 of 12")).toBeInTheDocument();
  });

  it("asks the index for the passage with the answer's claim", async () => {
    mockOpenPdf.mockResolvedValue(handle());
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PASSAGE.url);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(PASSAGE.body);
  });

  it("highlights the runs that hold the passage", async () => {
    mockOpenPdf.mockResolvedValue(handle());
    fetchSpy.mockResolvedValue(
      jsonResponse({
        passage: { text: "Der Auftragnehmer reagiert auf Störungen\ninnerhalb von vier Stunden." },
      })
    );

    renderViewer();

    await waitFor(() => expect(highlights()).toHaveLength(2));
    const [first, second] = Array.from(highlights()) as HTMLElement[];
    expect(first.style.top).toBe("120px");
    expect(second.style.top).toBe("140px");
    // A canvas has no text for a screen reader; the passage itself does.
    expect(screen.getByText(/Highlighted passage:/)).toHaveTextContent(
      "Der Auftragnehmer reagiert auf Störungen innerhalb von vier Stunden."
    );
  });

  it("shows the page unhighlighted when the index has no passage for it", async () => {
    const pdf = handle();
    mockOpenPdf.mockResolvedValue(pdf);
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    await screen.findByText("Page 4 of 12");
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(highlights()).toHaveLength(0);
  });

  it("shows the page unhighlighted when the passage is not on it", async () => {
    mockOpenPdf.mockResolvedValue(handle());
    fetchSpy.mockResolvedValue(
      jsonResponse({ passage: { text: "Diese Passage steht auf einer ganz anderen Seite." } })
    );

    renderViewer();

    await screen.findByText("Page 4 of 12");
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(highlights()).toHaveLength(0);
    expect(screen.queryByText(/Highlighted passage:/)).not.toBeInTheDocument();
  });

  it("shows the page unhighlighted when the passage lookup fails", async () => {
    mockOpenPdf.mockResolvedValue(handle());
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Passage lookup failed" }, { status: 502 }));

    renderViewer();

    await screen.findByText("Page 4 of 12");
    expect(highlights()).toHaveLength(0);
    expect(screen.queryByTestId("browser-viewer")).not.toBeInTheDocument();
  });

  it("asks for no passage when the citation has nothing to look up", async () => {
    mockOpenPdf.mockResolvedValue(handle());

    renderViewer(null);

    await screen.findByText("Page 4 of 12");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the browser's viewer when the document cannot be opened", async () => {
    // An encrypted or broken file, or a blocked worker: the highlight is an
    // enhancement and must never cost the reader the document.
    mockOpenPdf.mockRejectedValue(new Error("Invalid PDF structure"));
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    expect(await screen.findByTestId("browser-viewer")).toBeInTheDocument();
  });

  it("falls back to the browser's viewer when the page cannot be drawn", async () => {
    const pdf = handle();
    pdf.renderPage.mockRejectedValue(new Error("canvas exploded"));
    mockOpenPdf.mockResolvedValue(pdf);
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    expect(await screen.findByTestId("browser-viewer")).toBeInTheDocument();
  });

  it("pages through the document, leaving the highlight on the cited page", async () => {
    const pdf = handle();
    mockOpenPdf.mockResolvedValue(pdf);
    fetchSpy.mockResolvedValue(
      jsonResponse({ passage: { text: "§ 4 Reaktionszeiten Der Auftragnehmer" } })
    );

    renderViewer();
    await waitFor(() => expect(highlights()).toHaveLength(2));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    });
    await screen.findByText("Page 5 of 12");
    expect(pdf.renderPage.mock.calls.at(-1)?.[0]).toBe(5);
    expect(highlights()).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    });
    await screen.findByText("Page 4 of 12");
    await waitFor(() => expect(highlights()).toHaveLength(2));
  });

  it("cannot page past either end of the document", async () => {
    const pdf = handle(4);
    mockOpenPdf.mockResolvedValue(pdf);
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    await screen.findByText("Page 4 of 4");
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("releases the document when closed", async () => {
    const pdf = handle();
    mockOpenPdf.mockResolvedValue(pdf);
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    const { unmount } = renderViewer();
    await screen.findByText("Page 4 of 12");
    unmount();

    expect(pdf.destroy).toHaveBeenCalled();
  });

  it("gives a screen reader the page's text, which a canvas does not have", async () => {
    // The browser's viewer exposed the page text; drawing the page ourselves
    // must not take that away, highlight or not.
    mockOpenPdf.mockResolvedValue(handle());
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    expect(await screen.findByText(/Text of page 4:/)).toHaveTextContent(
      "§ 4 Reaktionszeiten Der Auftragnehmer reagiert auf Störungen innerhalb von vier Stunden. § 5 Vergütung"
    );
  });

  it("starts a page the reader turns to at its top", async () => {
    mockOpenPdf.mockResolvedValue(handle());
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();
    await screen.findByText("Page 4 of 12");
    const pane = screen.getByRole("region", { name: "Page 4" });
    pane.scrollTop = 900;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    });
    await screen.findByText("Page 5 of 12");

    expect(screen.getByRole("region", { name: "Page 5" }).scrollTop).toBe(0);
  });

  it("lets a keyboard scroll a page taller than the pane", async () => {
    mockOpenPdf.mockResolvedValue(handle());
    fetchSpy.mockResolvedValue(jsonResponse({ passage: null }));

    renderViewer();

    expect(await screen.findByRole("region", { name: "Page 4" })).toHaveAttribute("tabindex", "0");
  });
});
