"use client";

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api-client";
import { locatePassage } from "@/lib/knowledge/passage-match";
import type { CitedPassageRequest } from "@/lib/schemas/knowledge-base";
import { openPdf, type PdfHandle, type RenderedPdfPage } from "@/lib/pdf/browser-pdf";
import { findSectionPage, sectionPages } from "@/lib/pdf/outline";

export interface PassageLookup {
  url: string;
  body: CitedPassageRequest;
}

/** Used until the pane has a width to measure — jsdom, or a dialog mid-animation. */
const FALLBACK_WIDTH = 800;

/**
 * The cited page of a knowledge-base PDF, drawn by pdf.js, with the passage
 * the answer drew on highlighted (#1268).
 *
 * The browser's own viewer cannot do this: Chrome's accepts `#page=` and
 * nothing that marks text. So for a page citation the dialog draws the page
 * itself, and asks the index (`knowledge/passage`) which passage on it the
 * answer's claim came from. Everything else — a document opened without a
 * page, an attachment — keeps the browser's viewer, and so does this one the
 * moment anything goes wrong: `fallback` is that viewer, and an unopenable
 * file or an undrawable page shows it rather than an error. A missing
 * highlight or a failed lookup shows the page unhighlighted, which is what the
 * reader had before.
 *
 * The highlight stays on the cited page. Paging away is the reader reading on,
 * and the passage belongs to the page the citation named.
 *
 * A Word citation names a heading path instead of a page (Office addendum in
 * plans/2026-11-06-kb-citation-passage-highlight-design.md). The page is then
 * found here: the heading through the converted PDF's outline, the passage
 * among that section's pages. A heading the outline does not have opens the
 * browser's viewer — exactly what an Office citation opened before.
 */
export const CitationPdfViewer: FC<{
  /** The document's viewer url; its `#page=` fragment, if any, is ignored. */
  url: string;
  /** The cited page — a PDF page, or a slide of a converted presentation. */
  page: number | null;
  /** A Word citation's heading path, joined with " > "; used when `page` is null. */
  heading?: string;
  passage: PassageLookup | null;
  fallback: ReactNode;
  /** Told once when the viewer gives up and shows `fallback`. */
  onFallback?: () => void;
}> = ({ url, page: givenPage, heading, passage, fallback, onFallback }) => {
  const documentUrl = url.split("#")[0];
  const [pdf, setPdf] = useState<PdfHandle | null>(null);
  const [failed, setFailed] = useState(false);
  // Null while a Word section is still being found; then the page it is on.
  const [citedPage, setCitedPage] = useState(givenPage);
  const [page, setPage] = useState(givenPage);
  const [rendered, setRendered] = useState<{ page: number; result: RenderedPdfPage } | null>(null);
  const [passageText, setPassageText] = useState<string | null>(null);
  // A Word citation's section, once the outline has named its pages.
  const [section, setSection] = useState<{ first: number; last: number } | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // One state change for both: the dialog drops its own page label in the same
  // render the browser's viewer (which has its own) takes over.
  const fail = useEffectEvent(() => {
    setFailed(true);
    onFallback?.();
  });

  // Open the document once per url; release it when the dialog closes.
  useEffect(() => {
    let cancelled = false;
    let opened: PdfHandle | null = null;
    openPdf(documentUrl).then(
      (handle) => {
        if (cancelled) return handle.destroy();
        opened = handle;
        setPdf(handle);
      },
      () => !cancelled && fail()
    );
    return () => {
      cancelled = true;
      opened?.destroy();
    };
  }, [documentUrl]);

  // Which passage to highlight. Any failure is "no passage": the page is
  // still the right one, and nothing the reader asked for has failed.
  useEffect(() => {
    if (!passage) return;
    let cancelled = false;
    apiPost<{ passage: { text: string } | null }>(passage.url, passage.body).then(
      (res) => !cancelled && setPassageText(res.passage?.text ?? null),
      () => {}
    );
    return () => {
      cancelled = true;
    };
    // The lookup is keyed on what it asks, not on the object's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passage?.url, JSON.stringify(passage?.body)]);

  // A Word citation, first step: which pages of the converted PDF the cited
  // section spans, from the outline alone. It does not wait for the passage
  // lookup — that embeds the claim, seconds on a cold model — so the section
  // opens as soon as the document does, and a heading the outline does not
  // have falls back to the browser's viewer just as fast.
  useEffect(() => {
    if (citedPage !== null || !pdf) return;
    // Nothing to open at: the browser's viewer, rather than a spinner forever.
    if (!heading) return fail();
    let cancelled = false;
    pdf.outline().then(
      (entries) => {
        if (cancelled) return;
        const range = sectionPages(entries, heading, pdf.numPages);
        if (!range) return fail();
        setSection(range);
        setCitedPage(range.first);
        setPage(range.first);
      },
      () => !cancelled && fail()
    );
    return () => {
      cancelled = true;
    };
  }, [citedPage, heading, pdf]);

  // Second step, once the passage is known: which page of the section holds
  // it. Bounded by the section (`findSectionPage`), so a long document costs a
  // few pages' text, not all of it. The highlight moves to that page; the
  // reader moves with it only if they are still where the section opened.
  useEffect(() => {
    if (!pdf || !section || !passageText) return;
    let cancelled = false;
    findSectionPage(pdf, section, passageText).then((found) => {
      if (cancelled || found === section.first) return;
      setCitedPage(found);
      setPage((current) => (current === section.first ? found : current));
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, section, passageText]);

  useEffect(() => {
    if (!pdf || page === null || !canvasRef.current) return;
    let cancelled = false;
    const width = paneRef.current?.clientWidth || FALLBACK_WIDTH;
    pdf.renderPage(page, canvasRef.current, width).then(
      (result) => !cancelled && setRendered({ page, result }),
      (err: unknown) => {
        // A cancelled render is a page change overtaking it, not a failure.
        if (!cancelled && (err as { name?: string })?.name !== "RenderingCancelledException") {
          fail();
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  const shown = rendered?.page === page ? rendered.result : null;
  const highlighted =
    shown && passageText && page === citedPage
      ? locatePassage(
          shown.runs.map((run) => run.str),
          passageText
        )
      : null;

  // A page the reader turns to starts at its top; the cited page then
  // scrolls to its passage below, which runs after this.
  useLayoutEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [page]);

  // Bring the passage into view once it is drawn: on a phone the cited page
  // is taller than the pane, and the passage may sit below the fold.
  useLayoutEffect(() => {
    if (highlighted) highlightRef.current?.scrollIntoView?.({ block: "center" });
  }, [highlighted?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) return <>{fallback}</>;

  const numPages = pdf?.numPages ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Focusable so a keyboard can scroll a page taller than the pane, as it
        could in the browser's viewer. `scrollbar-gutter` keeps a classic
        scrollbar from appearing after the width was measured and pushing the
        page sideways.
       */}
      <div
        ref={paneRef}
        role="region"
        aria-label={page === null ? "Finding the cited section" : `Page ${page}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto bg-muted/40 [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="relative mx-auto w-fit">
          {!shown && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2
                className="size-5 animate-spin text-muted-foreground"
                aria-label="Loading page"
              />
            </div>
          )}
          <canvas ref={canvasRef} className="block bg-white" aria-hidden="true" />
          {shown &&
            highlighted?.map((index, i) => {
              const { rect } = shown.runs[index];
              return (
                <div
                  key={index}
                  ref={i === 0 ? highlightRef : undefined}
                  data-passage-highlight=""
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-[2px] bg-yellow-300/45 mix-blend-multiply"
                  style={{
                    left: `${rect.left}px`,
                    top: `${rect.top}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                  }}
                />
              );
            })}
        </div>
        {shown && (
          // The canvas has no text a screen reader can read; the browser's
          // viewer did. Same runs the highlight is computed from.
          <p className="sr-only">
            Text of page {page}:{" "}
            {shown.runs
              .map((run) => run.str)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim()}
          </p>
        )}
        {highlighted && passageText && (
          <p className="sr-only">Highlighted passage: {passageText.replace(/\s+/g, " ").trim()}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-1 border-t bg-background px-3 py-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Previous page"
          disabled={page === null || page <= 1}
          onClick={() => setPage((p) => (p === null ? p : p - 1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-24 text-center text-muted-foreground text-xs" aria-live="polite">
          {page === null
            ? "Finding the cited section…"
            : numPages === null
              ? `Page ${page}`
              : `Page ${page} of ${numPages}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Next page"
          disabled={numPages === null || page === null || page >= numPages}
          onClick={() => setPage((p) => (p === null ? p : p + 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
};
