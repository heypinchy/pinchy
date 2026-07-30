// @vitest-environment jsdom
/**
 * What the markdown renderer HANDS the lightbox for a citation — specifically,
 * the download list.
 *
 * Its own file with its own stub because the two neighbours each stop one step
 * short, deliberately:
 *
 *   - `markdown-citation-render.test.tsx` renders the real pipeline and stops
 *     at the trigger. Opening the dialog for real means driving a Radix portal
 *     in jsdom, which does not settle reliably here — and a test that is
 *     occasionally right is worse than a boundary drawn on purpose.
 *   - `pdf-dialog.test.tsx` renders the dialog open and proves it DISPLAYS a
 *     pair of downloads. It builds that pair itself, so it says nothing about
 *     whether the renderer ever supplies one.
 *
 * The gap between them is a whole feature: `buildSourceDownloads` could be
 * perfect and never called, and every test above would stay green while an
 * Office citation offered a single download of a file no browser renders.
 *
 * So this replaces `PdfDialog` with a stub that writes its props out, which is
 * the only seam that reaches the answer without the portal. It asserts the
 * WIRING and nothing else — what the dialog does with the list is the other
 * file's job.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TextMessagePartProvider } from "@assistant-ui/react";

vi.mock("@/components/assistant-ui/attachment-preview", () => ({
  PdfDialog: ({
    url,
    downloads,
    children,
  }: {
    url: string;
    downloads?: Array<{ label: string; url: string }>;
    children: React.ReactNode;
  }) => (
    <span
      data-testid="pdf-dialog"
      data-url={url}
      data-downloads={JSON.stringify(downloads ?? null)}
    >
      {children}
    </span>
  ),
}));

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { AgentIdContext } from "@/components/chat";

function renderAnswer(text: string) {
  return render(
    <AgentIdContext.Provider value="agent-1">
      <TextMessagePartProvider text={text} isRunning={false}>
        <MarkdownText smooth={false} />
      </TextMessagePartProvider>
    </AgentIdContext.Provider>
  );
}

async function downloadsOf(text: string): Promise<Array<{ label: string; url: string }> | null> {
  renderAnswer(text);
  const dialog = await screen.findByTestId("pdf-dialog");
  return JSON.parse(dialog.getAttribute("data-downloads")!);
}

describe("what the renderer hands the viewer for a citation", () => {
  it("supplies both representations of an Office source", async () => {
    const downloads = await downloadsOf("- [1] noack/QF_2012/Angebot.doc — S. 3");

    expect(downloads?.map((d) => d.label)).toEqual(["Angebot.doc", "Angebot.pdf"]);
  });

  it("supplies exactly one for a PDF, which has only one representation", async () => {
    const downloads = await downloadsOf("- [1] noack/PPR/document.pdf — p. 510");

    expect(downloads?.map((d) => d.label)).toEqual(["document.pdf"]);
  });

  it("opens the viewer at the citation's own url, unchanged by any of this", async () => {
    // The preview url is what carries `#page=N`, and the download urls are
    // derived FROM it. If this ever drifted, a reader would be shown one
    // document and handed another.
    renderAnswer("- [1] noack/QF_2012/Angebot.doc — S. 3");

    const dialog = await screen.findByTestId("pdf-dialog");
    expect(dialog.getAttribute("data-url")).toBe(
      "/api/agents/agent-1/workspace-file?path=%2Fdata%2Fnoack%2FQF_2012%2FAngebot.doc#page=3"
    );
  });
});
