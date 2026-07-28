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
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PdfDialog } from "@/components/assistant-ui/attachment-preview";

function openDialog(url: string, title: string, page: number | null = null) {
  return render(
    <PdfDialog url={url} title={title} page={page} defaultOpen>
      <button type="button">trigger</button>
    </PdfDialog>
  );
}

const SOURCE_URL =
  "/api/agents/a1/workspace-file?path=%2Fdata%2Fnoack%2FPPR%2Fdocument.pdf#page=510";

describe("PdfDialog", () => {
  it("names the document by its filename, not the route or the full path", () => {
    // Chrome's own title bar reads "workspace-file" here — the route segment.
    // A reader checking a citation needs to know WHICH document opened.
    openDialog(SOURCE_URL, "/data/noack/PPR/document.pdf");

    expect(screen.getByText("document.pdf")).toBeInTheDocument();
  });

  it("keeps the full path reachable without spending width on it", () => {
    // A corpus has same-named files in different folders, so the path has to
    // survive somewhere — but it must not push the controls off a narrow screen.
    openDialog(SOURCE_URL, "/data/noack/PPR/document.pdf");

    expect(screen.getByTitle("/data/noack/PPR/document.pdf")).toBeInTheDocument();
  });

  it("shows which page the citation pointed at", () => {
    // The page is PASSED IN, not re-read from the url. `parseSourceHref` already
    // decided what a citation's page is; a second regex here would be a second
    // answer to the same question, and the two had already drifted (`\d{1,5}`
    // against a whole fragment vs `\d+` anywhere in the string).
    openDialog(SOURCE_URL, "/data/noack/PPR/document.pdf", 510);

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
    openDialog(SOURCE_URL, "/data/noack/PPR/document.pdf");

    const link = screen.getByRole("link", { name: /open in new tab/i });
    expect(link).toHaveAttribute("href", SOURCE_URL);
    expect(link).toHaveAttribute("target", "_blank");
    // noreferrer keeps the opened tab from reaching back via window.opener.
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("still closes", () => {
    openDialog(SOURCE_URL, "/data/noack/PPR/document.pdf");

    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("renders the viewer at the exact url it was given, fragment included", () => {
    // The `#page=N` fragment is the whole reason a citation lands where it does.
    const { container } = openDialog(SOURCE_URL, "/data/noack/PPR/document.pdf");

    const embed = container.ownerDocument.querySelector("embed");
    expect(embed).toHaveAttribute("src", SOURCE_URL);
    expect(embed).toHaveAttribute("type", "application/pdf");
  });
});
