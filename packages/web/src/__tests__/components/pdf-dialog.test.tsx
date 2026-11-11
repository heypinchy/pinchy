// @vitest-environment jsdom
/**
 * The lightbox a PDF opens into — shared by a chat attachment and a cited
 * knowledge-base source.
 *
 * Its layout is constrained by something we do not control: the PDF viewer
 * inside it belongs to the browser. Chrome, Firefox and Safari each render a
 * different toolbar, in different places, and none of them is ours to arrange.
 * Floating our own controls on top of that surface is what produced the
 * original defect — the close button landed on Chrome's overflow menu, and had
 * to be tinted dark just to stay legible against a viewer whose colours we
 * cannot predict.
 *
 * So our chrome sits in a row ABOVE the viewer instead of on top of it. These
 * tests pin the consequences of that decision: the row identifies the document
 * (the browser's own title bar shows the route name, "workspace-file", which
 * tells a reader nothing), and it carries an escape hatch to a full tab —
 * which is also the only thing that works on iOS Safari, where an embedded PDF
 * renders blank no matter what we do.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mockOpenPdf = vi.fn();
vi.mock("@/lib/pdf/browser-pdf", () => ({
  openPdf: (...args: unknown[]) => mockOpenPdf(...args),
}));

import { PdfDialog } from "@/components/assistant-ui/attachment-preview";
import { buildSourceDownloads, buildSourceHref } from "@/lib/knowledge/source-links";

function openDialog(url: string, title: string, page: number | null = null) {
  return render(
    <PdfDialog url={url} title={title} page={page} defaultOpen>
      <button type="button">trigger</button>
    </PdfDialog>
  );
}

const SOURCE_URL =
  "/api/agents/a1/workspace-file?path=%2Fdata%2Fcustomer%2FPPR%2Fdocument.pdf#page=510";

describe("PdfDialog", () => {
  it("names the document by its filename, not the route or the full path", () => {
    // Chrome's own title bar reads "workspace-file" here — the route segment.
    // A reader checking a citation needs to know WHICH document opened.
    openDialog(SOURCE_URL, "customer/PPR/document.pdf");

    expect(screen.getByText("document.pdf")).toBeInTheDocument();
  });

  it("keeps the full path reachable without spending width on it", () => {
    // A corpus has same-named files in different folders, so the path has to
    // survive somewhere — but it must not push the controls off a narrow screen.
    openDialog(SOURCE_URL, "customer/PPR/document.pdf");

    expect(screen.getByTitle("customer/PPR/document.pdf")).toBeInTheDocument();
  });

  it("shows which page the citation pointed at", () => {
    // The page is PASSED IN, not re-read from the url. `parseSourceHref` already
    // decided what a citation's page is; a second regex here would be a second
    // answer to the same question, and the two had already drifted (`\d{1,5}`
    // against a whole fragment vs `\d+` anywhere in the string).
    openDialog(SOURCE_URL, "customer/PPR/document.pdf", 510);

    expect(screen.getByText(/page 510/i)).toBeInTheDocument();
  });

  it("says nothing about a page when the file was not opened at one", () => {
    // An attachment opens at the start; inventing "Page 1" would be noise.
    openDialog("/api/agents/a1/uploads/report.pdf", "report.pdf");

    expect(screen.queryByText(/page \d/i)).not.toBeInTheDocument();
  });

  it("offers a full tab, which is the only working path on iOS Safari", () => {
    // iOS Safari renders an embedded PDF blank regardless of headers or markup.
    // Without this link the dialog is a dead end on every iPhone.
    openDialog(SOURCE_URL, "customer/PPR/document.pdf");

    const link = screen.getByRole("link", { name: /open in new tab/i });
    expect(link).toHaveAttribute("href", SOURCE_URL);
    expect(link).toHaveAttribute("target", "_blank");
    // noreferrer keeps the opened tab from reaching back via window.opener.
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("still closes", () => {
    openDialog(SOURCE_URL, "customer/PPR/document.pdf");

    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("renders the viewer at the exact url it was given, fragment included", () => {
    // The `#page=N` fragment is the whole reason a citation lands where it does.
    const { container } = openDialog(SOURCE_URL, "customer/PPR/document.pdf");

    const embed = container.ownerDocument.querySelector("embed");
    expect(embed).toHaveAttribute("src", SOURCE_URL);
    expect(embed).toHaveAttribute("type", "application/pdf");
  });
});

/**
 * Reading the answer is often not the end of the job. The customer this was
 * built for reaches the cited file through Citrix — save it to a local disk,
 * then attach it to a mail, because Citrix cannot attach directly — and asked
 * for that detour to go away: "hätte aber trotzdem gern das Dokument, dass man
 * den Kunden schicken kann."
 *
 * The serving half was already there (the route derives its disposition from
 * the extension); only the affordance was missing. What these tests pin is that
 * it is an affordance a keyboard reaches and a screen reader names, and that it
 * asks the server for a copy rather than quietly reusing the view request —
 * governance has to be able to tell the two apart.
 */
describe("PdfDialog — taking the document", () => {
  it("offers a way to keep the document, not just look at it", () => {
    openDialog(SOURCE_URL, "/data/customer/PPR/document.pdf");

    // A link, not a div with a click handler: that is what makes it reachable
    // by keyboard at all, and `getByRole("link")` only matches an element that
    // actually has an href.
    const link = screen.getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute("href");
  });

  it("asks the server for a copy, so the download is logged as one", () => {
    // Same bytes, different act. Without the flag the request is
    // indistinguishable from opening the viewer, and the audit trail cannot
    // answer who took the actual spec sheet out of the building.
    openDialog(SOURCE_URL, "/data/customer/PPR/document.pdf");

    const href = screen.getByRole("link", { name: /download/i }).getAttribute("href")!;
    const parsed = new URL(href, "http://localhost");
    expect(parsed.searchParams.get("download")).toBe("1");
    // The path has to survive intact — it is what the route resolves.
    expect(parsed.searchParams.get("path")).toBe("/data/customer/PPR/document.pdf");
  });

  it("also asks the browser to save, for the routes that never see the flag", () => {
    // A chat attachment is served by uploads/[filename], which knows nothing
    // about `download=1` and hands back `inline` for a PDF. The attribute is
    // the ONLY thing that makes the control do its job there, so it cannot be
    // left to survive `asChild` by luck.
    //
    // Deliberately valueless: a filled-in name would override the
    // Content-Disposition filename, which is the one carrying umlauts intact.
    openDialog("/api/agents/a1/uploads/report.pdf", "report.pdf");

    const link = screen.getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute("download", "");
  });

  it("downloads the whole document even when the citation opened at one page", () => {
    // `#page=510` positions a viewer. Carried onto a download it means nothing,
    // and a saved file named after a fragment would be worse than nothing.
    openDialog(SOURCE_URL, "/data/customer/PPR/document.pdf");

    const href = screen.getByRole("link", { name: /download/i }).getAttribute("href")!;
    expect(href).not.toContain("#");
  });

  it("names the document in the download label rather than saying just 'download'", () => {
    // Wave 2 puts a second entry beside this one (the original next to its
    // converted PDF), and two controls both labelled "Download" would be a
    // coin flip for anyone not looking at the screen.
    openDialog(SOURCE_URL, "/data/customer/PPR/document.pdf");

    expect(screen.getByRole("link", { name: /download document\.pdf/i })).toBeInTheDocument();
  });

  it("takes a second document action as a list entry, not a redesign", () => {
    // The header is built for a small set of document actions. This is the
    // shape Wave 2 uses when a scanned Office file gains a converted PDF
    // alongside the original — data, not a rewrite of the header.
    render(
      <PdfDialog
        url={SOURCE_URL}
        title="/data/customer/PPR/report.docx"
        downloads={[
          {
            label: "original",
            url: "/api/agents/a1/workspace-file?path=%2Freport.docx&download=1",
          },
          {
            label: "converted PDF",
            url: "/api/agents/a1/workspace-file?path=%2Freport.pdf&download=1",
          },
        ]}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    expect(screen.getByRole("link", { name: /download original/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download converted pdf/i })).toBeInTheDocument();
  });

  it("offers an Office citation both representations, built by the renderer", () => {
    // The pair is not hand-assembled at the call site: `buildSourceDownloads`
    // derives it from the same href the viewer opens, which is what keeps the
    // download urls and the preview url describing one document. Rendering it
    // here proves the two halves fit — the list shape and the labels a reader
    // actually distinguishes them by.
    const href = buildSourceHref("a1", "customer/archive-2012/Angebot.doc", {
      kind: "page",
      page: 3,
    });
    render(
      <PdfDialog
        url={href}
        title="customer/archive-2012/Angebot.doc"
        page={3}
        downloads={buildSourceDownloads(href)!}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    const original = screen.getByRole("link", { name: "Download Original (.doc): Angebot.doc" });
    const converted = screen.getByRole("link", { name: "Download PDF: Angebot.pdf" });
    expect(original).toHaveTextContent("Original (.doc)");
    expect(converted).toHaveTextContent("PDF");
  });

  it("tells the two downloads apart at a glance, and names the file on hover (#1268)", () => {
    // Labelled by filename, both read "Vorlage_Wartung…" once the header
    // truncated them. The visible label says which representation each is;
    // the tooltip still says which file lands in the downloads folder.
    const href = buildSourceHref("a1", "customer/Vorlage_Wartung_Kundendienst_2026.docx", null);
    render(
      <PdfDialog
        url={href}
        title="customer/Vorlage_Wartung_Kundendienst_2026.docx"
        downloads={buildSourceDownloads(href)!}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    const links = screen.getAllByRole("link", { name: /^download/i });
    expect(links.map((link) => link.textContent)).toEqual(["Original (.docx)", "PDF"]);
    expect(links.map((link) => link.getAttribute("title"))).toEqual([
      "Vorlage_Wartung_Kundendienst_2026.docx",
      "Vorlage_Wartung_Kundendienst_2026.pdf",
    ]);
  });

  it("keeps the controls on screen when the document name is too long for the row", () => {
    // jsdom has no layout, so this asserts the mechanism rather than measuring
    // the result: the title is the element allowed to give up width, and the
    // control group is the one that must not. Getting this backwards pushes
    // Download and Close off the right edge of a phone, which is exactly where
    // a reader forwarding a document to a customer is most likely to be.
    const longName = "Prüfbericht Nr. 5 – Ölwanne, Revision C, freigegeben 2026-07-28.pdf";
    openDialog(SOURCE_URL, `/data/customer/PPR/${longName}`);

    const title = screen.getByText(longName);
    expect(title.className).toContain("truncate");

    const controls = screen.getByRole("link", { name: /download/i }).parentElement!;
    expect(controls.className).toContain("shrink-0");
  });
});

/**
 * A page citation with a passage to find opens into our own renderer instead
 * of the browser's viewer, which cannot highlight (#1268). Everything else
 * keeps the browser's viewer — see citation-pdf-viewer.test.tsx for the
 * renderer itself.
 */
describe("PdfDialog with a passage to highlight", () => {
  const passage = {
    url: "/api/agents/a1/knowledge/passage",
    body: { path: "/data/customer/PPR/document.pdf", page: 510 },
  };

  it("draws the cited page itself instead of embedding the browser's viewer", async () => {
    mockOpenPdf.mockReset().mockResolvedValue({
      numPages: 600,
      renderPage: vi.fn(async () => ({ width: 600, height: 800, runs: [] })),
      destroy: vi.fn(),
    });
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ passage: null }), { status: 200 }));

    render(
      <PdfDialog
        url={SOURCE_URL}
        title="customer/PPR/document.pdf"
        page={510}
        passage={passage}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    expect(await screen.findByText("Page 510 of 600")).toBeInTheDocument();
    expect(document.querySelector("embed")).toBeNull();
    // One page label, not the header's and the viewer's both.
    expect(screen.getAllByText(/page 510/i)).toHaveLength(1);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    fetchSpy.mockRestore();
  });

  it("falls back to the browser's viewer at the cited page when the document will not open", async () => {
    mockOpenPdf.mockReset().mockRejectedValue(new Error("Invalid PDF structure"));
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ passage: null }), { status: 200 }));

    render(
      <PdfDialog
        url={SOURCE_URL}
        title="customer/PPR/document.pdf"
        page={510}
        passage={passage}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    await waitFor(() => expect(document.querySelector("embed")).toHaveAttribute("src", SOURCE_URL));
    expect(screen.getByText(/page 510/i)).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("keeps the browser's viewer when there is no passage to look for", () => {
    mockOpenPdf.mockReset();

    render(
      <PdfDialog
        url={SOURCE_URL}
        title="customer/PPR/document.pdf"
        page={510}
        passage={null}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    expect(document.querySelector("embed")).toHaveAttribute("src", SOURCE_URL);
    expect(mockOpenPdf).not.toHaveBeenCalled();
  });

  it("draws a slide citation at its slide, which is the converted PDF's page", async () => {
    const renderPage = vi.fn(async (_page: number) => ({ width: 600, height: 800, runs: [] }));
    mockOpenPdf.mockReset().mockResolvedValue({ numPages: 20, renderPage, destroy: vi.fn() });
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ passage: null }), { status: 200 }));
    const deckUrl = "/api/agents/a1/workspace-file/Pitch.pdf?path=%2Fdata%2Fsales%2FPitch.pptx";

    render(
      <PdfDialog
        url={deckUrl}
        title="sales/Pitch.pptx"
        page={null}
        passage={{
          url: "/api/agents/a1/knowledge/passage",
          body: { path: "/data/sales/Pitch.pptx", slide: 7 },
        }}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    expect(await screen.findByText("Page 7 of 20")).toBeInTheDocument();
    expect(renderPage.mock.calls[0][0]).toBe(7);
    expect(document.querySelector("embed")).toBeNull();
    fetchSpy.mockRestore();
  });

  it("opens a Word citation as before when its heading cannot be found", async () => {
    mockOpenPdf.mockReset().mockResolvedValue({
      numPages: 20,
      renderPage: vi.fn(),
      outline: vi.fn(async () => []),
      pageRuns: vi.fn(async () => []),
      destroy: vi.fn(),
    });
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ passage: null }), { status: 200 }));
    const wordUrl = "/api/agents/a1/workspace-file/Handbuch.pdf?path=%2Fdata%2Fq%2FHandbuch.docx";

    render(
      <PdfDialog
        url={wordUrl}
        title="q/Handbuch.docx"
        page={null}
        passage={{
          url: "/api/agents/a1/knowledge/passage",
          body: { path: "/data/q/Handbuch.docx", heading: "Wartung" },
        }}
        defaultOpen
      >
        <button type="button">trigger</button>
      </PdfDialog>
    );

    await waitFor(() => expect(document.querySelector("embed")).toHaveAttribute("src", wordUrl));
    // No page to name: the browser's viewer opens at the top, as it did.
    expect(screen.queryByText(/page \d/i)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });
});
