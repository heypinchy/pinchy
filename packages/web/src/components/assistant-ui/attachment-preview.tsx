"use client";

import { useContext, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { useMessagePartFile } from "@assistant-ui/react";
import { Download, ExternalLink, FileText, Loader2, X } from "lucide-react";
import { AgentIdContext, AgentModelContext, FileSourceContext } from "@/components/chat";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { imageInputNote } from "@/lib/attachment-capability";
import {
  CitationPdfViewer,
  type PassageLookup,
} from "@/components/assistant-ui/citation-pdf-viewer";

import { useModelCapabilities } from "@/hooks/use-model-capabilities";

// See a32cd2c7b for the probe rationale. The main race is resolved by multipart
// pre-upload (#324) but the probe stays as a defence against server-side delays.
const PROBE_SCHEDULE_MS = [200, 400, 800, 1600] as const;
type ProbeState = "probing" | "ready" | "failed";

function useUploadReadiness(url: string | null): ProbeState {
  const [state, setState] = useState<ProbeState>(url ? "probing" : "ready");
  const urlRef = useRef(url);

  useEffect(() => {
    urlRef.current = url;
    if (!url) {
      setState("ready");
      return;
    }
    setState("probing");
    const ctrl = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function probe(): Promise<void> {
      try {
        const res = await fetch(url!, { method: "HEAD", signal: ctrl.signal });
        if (ctrl.signal.aborted || urlRef.current !== url) return;
        if (res.ok) {
          setState("ready");
          return;
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      const delay = PROBE_SCHEDULE_MS[attempt];
      attempt += 1;
      if (delay === undefined) {
        setState("failed");
        return;
      }
      timer = setTimeout(() => {
        if (!ctrl.signal.aborted) probe();
      }, delay);
    }

    probe();

    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [url]);

  return state;
}

/**
 * URL the browser fetches the uploaded file from. Filename is encoded so
 * spaces / parentheses / unicode all survive — the route handler decodes it
 * back via Next's params resolution.
 */
function buildFileUrl(agentId: string, filename: string, source: "uploads" | "artifacts"): string {
  return `/api/agents/${encodeURIComponent(agentId)}/${source}/${encodeURIComponent(filename)}`;
}

/**
 * Renders an attachment chip next to a chat message bubble. Branches by MIME:
 *
 * - `application/pdf` → small `<embed>` thumbnail; click opens a modal with
 *   the browser's native PDF viewer at full size.
 * - `image/*` → inline `<img>`; click opens a modal with the full image.
 * - anything else → a chip that downloads the file (#1298): a CSV or XLSX
 *   has no viewer here, and taking it away is what it was delivered for.
 * - missing agentId / filename → a plain chip, since there is no URL to build.
 */
export const AttachmentPreview: FC = () => {
  const { mimeType, filename } = useMessagePartFile();
  const agentId = useContext(AgentIdContext);
  const agentModel = useContext(AgentModelContext);
  const fileSource = useContext(FileSourceContext);
  const { data: capabilityMap } = useModelCapabilities();
  const modelCapabilities = agentModel ? (capabilityMap?.[agentModel] ?? null) : null;

  const isPreviewable =
    !!agentId && !!filename && (mimeType === "application/pdf" || mimeType.startsWith("image/"));
  const url = isPreviewable ? buildFileUrl(agentId!, filename!, fileSource) : null;
  const readiness = useUploadReadiness(url);

  const capabilityWarning = imageInputNote(mimeType, modelCapabilities?.vision);

  // Falls back to a chip when we don't have everything we need to build a URL.
  if (!agentId || !filename) {
    return <Chip filename={filename} mimeType={mimeType} warning={capabilityWarning} />;
  }

  // Probe budget exhausted → render the chip so the message still shows the
  // filename and does not silently look attachment-less. A page reload re-runs
  // the probe against the (by then persisted) file.
  if (readiness === "failed") {
    return <Chip filename={filename} mimeType={mimeType} warning={capabilityWarning} />;
  }

  if (mimeType === "application/pdf") {
    if (readiness === "probing") return <Probing filename={filename} />;
    return <PdfPreview url={url!} filename={filename} warning={capabilityWarning} />;
  }
  if (mimeType.startsWith("image/")) {
    if (readiness === "probing") return <Probing filename={filename} />;
    return <ImagePreview url={url!} filename={filename} warning={capabilityWarning} />;
  }
  return (
    <Chip
      filename={filename}
      mimeType={mimeType}
      warning={capabilityWarning}
      href={buildFileUrl(agentId, filename, fileSource)}
    />
  );
};

const CapabilityWarning: FC<{ message: string }> = ({ message }) => (
  <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">{message}</p>
);

/**
 * One "take this document" entry in the dialog header. A list rather than a
 * single url because the second entry is already on the way: once a scanned
 * Office file is converted, the same dialog offers the original beside its
 * converted PDF, and that has to be a datum rather than a redesign of the row.
 */
export type DocumentDownload = {
  label: string;
  url: string;
  /**
   * The name the file lands under, when the label is not it — "PDF" names a
   * representation, `Angebot.pdf` names the file. Shown on hover and carried
   * in the accessible name, so a screen reader hears which file it is taking.
   */
  filename?: string;
  /**
   * Which representation of the document this entry hands over. `converted`
   * marks the PDF an Office source or a scan is SHOWN as — which may not exist
   * yet, so a dialog given one checks before showing it (see PdfDialog).
   */
  variant?: "original" | "converted";
};

/** "Download PDF: Angebot.pdf" — starts with the visible label (WCAG 2.5.3). */
function downloadAccessibleName({ label, filename }: DocumentDownload): string {
  return filename && filename !== label ? `Download ${label}: ${filename}` : `Download ${label}`;
}

/**
 * The url the same document is fetched from when the reader wants to keep it.
 *
 * Two things happen here rather than in the browser. `download=1` is what makes
 * the route serve `attachment` instead of `inline` AND what makes it write
 * `knowledge.source_downloaded` — a `download` attribute alone would leave the
 * server believing every download was a view, and governance asks a different
 * question about a copy that left the building than about a pane someone read.
 *
 * The fragment goes: `#page=510` positions a viewer and means nothing to a
 * saved file.
 */
function downloadUrlFor(url: string): string {
  const withoutFragment = url.split("#")[0];
  return `${withoutFragment}${withoutFragment.includes("?") ? "&" : "?"}download=1`;
}

/**
 * Whether the converted PDF a dialog is about to show exists. `missing` only on
 * a 404 — the route's answer for "no converted artifact"; anything else (a
 * network failure, a 5xx) is no verdict on the PDF, and the viewer opens as it
 * always did.
 */
type ConvertedAvailability = "checking" | "available" | "missing";

function useConvertedAvailability(
  url: string,
  enabled: boolean,
  open: boolean,
  openCount: number
): ConvertedAvailability {
  // Keyed on the open it answers for, so a reopened dialog reads "checking" in
  // its very first render rather than the last open's answer — an <embed>
  // mounted for one frame is already a request for the 404.
  //
  // Asked only while open, but NOT reset by closing: the content outlives
  // `open` for its exit animation (and for one commit even without one), and
  // reading "available" there mounts that same <embed> on the way out.
  const [answer, setAnswer] = useState<{
    key: string;
    value: Exclude<ConvertedAvailability, "checking">;
  } | null>(null);
  const key = `${openCount}:${url}`;

  useEffect(() => {
    if (!enabled || !open) return;
    const ctrl = new AbortController();
    const settle = (value: "available" | "missing") =>
      !ctrl.signal.aborted && setAnswer({ key, value });
    // HEAD: the headers are the whole answer, and the route sends no body for
    // one. It is gated and audited like the view it precedes.
    fetch(url.split("#")[0], { method: "HEAD", signal: ctrl.signal }).then(
      (res) => settle(res.status === 404 ? "missing" : "available"),
      () => settle("available")
    );
    return () => ctrl.abort();
  }, [url, enabled, open, key]);

  if (!enabled) return "available";
  return answer?.key === key ? answer.value : "checking";
}

/**
 * The lightbox a PDF opens into, and the only place its presentation is
 * defined. Shared so a chat attachment and a cited knowledge-base source open
 * the exact same way — two viewers for "look at this PDF" would drift in
 * sizing, close treatment and keyboard behaviour, and the citation link exists
 * precisely so a reader can check a claim without leaving the answer.
 *
 * The layout is dictated by one constraint: the viewer inside is the BROWSER's,
 * not ours. Chrome, Firefox and Safari each draw a different toolbar in a
 * different place, so there is no region we can reliably float a control over.
 * An earlier version tried — the close button landed on Chrome's overflow menu
 * and had to be tinted dark just to stay legible against a surface whose colour
 * we cannot predict, while the dialog's own padding showed as a pale frame
 * around a viewer that already draws its own.
 *
 * So our chrome occupies a row ABOVE the viewer and the viewer gets everything
 * below it, edge to edge. Nothing overlaps, nothing needs tinting, and the row
 * earns its height: it names the document in our own words, whatever the
 * browser's viewer makes of the url or the file's metadata, and it offers
 * a full tab — the only thing that works on iOS Safari, where an embedded PDF
 * renders blank whatever we do.
 *
 * `children` is the trigger, so each caller keeps its own affordance: the
 * attachment renders an <embed> thumbnail, a citation renders its path as text.
 */
export const PdfDialog: FC<{
  url: string;
  title: string;
  /**
   * The page the url opens at, when it opens at one. Passed in rather than
   * re-read from the url: `parseSourceHref` already answers that question for a
   * citation, and a second reading here is a pair that drifts — the two had in
   * fact already disagreed on what counts as a page fragment.
   */
  page?: number | null;
  /**
   * What the reader may take away. Defaults to the document being shown, which
   * is the only thing there is to take today; a caller that has more than one
   * representation of the same document passes them all.
   *
   * An entry marked `variant: "converted"` says the document SHOWN is a
   * conversion (an Office source, a scan), and a conversion may not exist: not
   * converted yet, or refused. The dialog then asks the route first, on every
   * open, and when there is none it says so and points at the original rather
   * than embedding the route's bare 404 — and stops offering the PDF and the
   * full tab, both of which would be that same 404. While it asks, both stay
   * in place but inert, so nothing hands over a 404 and nothing moves.
   */
  downloads?: DocumentDownload[];
  /**
   * The cited passage to find on `page`, for a knowledge-base citation (#1268).
   * With one, the page is drawn by our own renderer, which can highlight it;
   * without one — an attachment, a citation without a page — the browser's
   * viewer shows the document as before. The renderer falls back to that same
   * viewer on any failure.
   */
  passage?: PassageLookup | null;
  children: ReactNode;
  /** Test-only escape hatch; the dialog is trigger-driven in the app. */
  defaultOpen?: boolean;
}> = ({ url, title, page, downloads, passage, children, defaultOpen }) => {
  // `title` is a filename for an attachment and a full path for a citation.
  // Show the leaf either way and keep the rest in the tooltip: a corpus has
  // same-named files in different folders, so the path has to stay reachable,
  // but spending header width on it would push the controls off a narrow screen.
  const filename = title.split("/").filter(Boolean).pop() ?? title;

  const [open, setOpen] = useState(defaultOpen ?? false);
  const [openCount, setOpenCount] = useState(0);
  const showsConversion = Boolean(downloads?.some((d) => d.variant === "converted"));
  // Asked only while open, and afresh on every open: the dialog is mounted
  // with every citation in an answer, a check is a request the route audits,
  // and a document converted since the last open has a preview now.
  const availability = useConvertedAvailability(url, showsConversion, open, openCount);
  const missing = availability === "missing";
  // The PDF is offered — downloaded or opened in a tab — only once it is known
  // to exist: the check hashes the source, long enough on a large deck for a
  // click to hand over the 404 it is there to catch. Until then its controls
  // keep their place, inert: appearing late, they would shift the ones beside
  // them under a reader's cursor.
  const offersPdf = availability === "available";

  const documentDownloads = (downloads ?? [{ label: filename, url: downloadUrlFor(url) }]).filter(
    (d) => !(missing && d.variant === "converted")
  );
  const original = documentDownloads.find((d) => d.variant === "original");
  // With one entry the icon is unambiguous. With two it is not — "the original
  // or the converted one?" is exactly the question a bare pair of identical
  // icons refuses to answer — so each names itself as soon as there is a
  // choice to make.
  const namesDownloads = documentDownloads.length > 1;
  // Where the drawn document opens: the cited page of a PDF, the cited slide
  // of a presentation (slide N is page N of its converted PDF), or — for a Word
  // citation — the page the viewer finds the cited heading on.
  const body = passage?.body;
  const startPage = page ?? (body && "slide" in body ? body.slide : null);
  const startHeading = body && "heading" in body ? body.heading : undefined;
  const highlightsPassage = Boolean(passage) && (startPage !== null || Boolean(startHeading));
  // The viewer below the header names the page itself, with the page count
  // and as the reader pages on; a second, static label would contradict it.
  const [showsOwnRenderer, setShowsOwnRenderer] = useState(highlightsPassage);

  /*
    Remounted per open (the dialog unmounts its content when closed), which
    is what makes `#page=N` in the url actually land: a PDF viewer honours
    the fragment on load, not on a later fragment change.
    `min-h-0` lets this shrink inside the flex column — without it the
    embed keeps its intrinsic height and pushes the header off-screen.
   */
  const browserViewer = (
    <embed src={url} type="application/pdf" className="block min-h-0 w-full flex-1" />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Each open tries the renderer afresh: a fallback was about that open.
        if (next) {
          setShowsOwnRenderer(highlightsPassage);
          setOpenCount((count) => count + 1);
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        // Taller and wider than a default dialog because a page of A4 at a
        // readable zoom is simply large — but deliberately not full-screen: the
        // answer staying visible behind it is the point of checking a citation
        // here rather than in a new tab. `dvh` (not `vh`) so a mobile browser's
        // collapsing toolbar cannot cut off the bottom of the viewer.
        className="flex h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="truncate font-medium text-sm" title={title}>
            {filename}
          </DialogTitle>
          {page !== null && page !== undefined && !showsOwnRenderer && (
            <span className="shrink-0 text-muted-foreground text-xs">Page {page}</span>
          )}
          {/*
            `shrink-0` is what keeps these on screen: the title above is the
            element allowed to give up width (it truncates), and without this
            the controls are what a long document name pushes off the right
            edge of a phone — where a reader forwarding a document to a
            customer is most likely to be standing.
           */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {documentDownloads.map((download) =>
              !offersPdf && download.variant === "converted" ? (
                <Button
                  key={download.url}
                  variant="ghost"
                  size={namesDownloads ? "sm" : "icon"}
                  className={namesDownloads ? undefined : "size-8"}
                  disabled
                  aria-label={downloadAccessibleName(download)}
                  title={download.filename ?? download.label}
                >
                  <Download className="size-4" />
                  {namesDownloads && <span className="max-w-32 truncate">{download.label}</span>}
                </Button>
              ) : (
                <Button
                  key={download.url}
                  variant="ghost"
                  size={namesDownloads ? "sm" : "icon"}
                  className={namesDownloads ? undefined : "size-8"}
                  asChild
                >
                  {/*
                  `download` covers the routes that do not read `download=1`
                  (a chat attachment is served by uploads/[filename]); the query
                  parameter is what makes the knowledge-base route both serve an
                  attachment and log the act as a download. Left without a value
                  on purpose, so a Content-Disposition filename — the one that
                  carries umlauts intact — still wins.
                 */}
                  <a
                    href={download.url}
                    download
                    aria-label={downloadAccessibleName(download)}
                    title={download.filename ?? download.label}
                  >
                    <Download className="size-4" />
                    {namesDownloads && <span className="max-w-32 truncate">{download.label}</span>}
                  </a>
                </Button>
              )
            )}
            {offersPdf ? (
              <Button variant="ghost" size="icon" className="size-8" asChild>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="Open in new tab"
                >
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            ) : (
              !missing && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled
                  aria-label="Open in new tab"
                >
                  <ExternalLink className="size-4" />
                </Button>
              )
            )}
            <DialogClose asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Close">
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
        </div>
        {/*
          Mounted with the dialog and empty until there is something to say: a
          live region is announced when its text changes, not reliably when it
          arrives already filled. Focus sits in the header, so without it a
          screen reader would never hear why the pane holds no document.
         */}
        <p role="status" className="sr-only">
          {missing
            ? "There's no preview of this document. You can download the original instead."
            : ""}
        </p>
        {availability === "checking" ? (
          <div className="flex flex-1 items-center justify-center bg-muted/40">
            <Loader2
              className="size-5 animate-spin text-muted-foreground"
              aria-label="Loading preview"
            />
          </div>
        ) : missing ? (
          <NoPreview original={original} />
        ) : highlightsPassage && passage ? (
          <CitationPdfViewer
            url={url}
            page={startPage}
            heading={startHeading}
            passage={passage}
            onFallback={() => setShowsOwnRenderer(false)}
            fallback={browserViewer}
          />
        ) : (
          browserViewer
        )}
      </DialogContent>
    </Dialog>
  );
};

/**
 * What the pane says instead of embedding the route's 404 for a converted PDF
 * that does not exist. Honest about why without guessing which reason applies
 * — the route does not say, and both are ordinary — and the way out is the
 * original, which holds everything the answer cited.
 */
const NoPreview: FC<{ original: DocumentDownload | undefined }> = ({ original }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/40 p-6 text-center">
    <FileText className="size-8 text-muted-foreground" />
    {/* Announced through the dialog's own status region, which outlives this. */}
    <div className="flex flex-col gap-3">
      <p className="font-medium text-sm">We can&apos;t preview this document</p>
      <p className="max-w-md text-muted-foreground text-sm">
        Its preview is the PDF we convert it to, and there isn&apos;t one: it hasn&apos;t been
        converted yet, or it couldn&apos;t be. The original has everything the answer cited.
      </p>
    </div>
    {original && (
      <Button variant="outline" size="sm" asChild>
        <a
          href={original.url}
          download
          aria-label={downloadAccessibleName(original)}
          title={original.filename ?? original.label}
        >
          <Download className="size-4" />
          Download {original.label}
        </a>
      </Button>
    )}
  </div>
);

const PdfPreview: FC<{ url: string; filename: string; warning: string | null }> = ({
  url,
  filename,
  warning,
}) => (
  <div>
    <PdfDialog url={url} title={filename}>
      <button
        type="button"
        aria-label={`Preview ${filename}`}
        className={`my-2 block max-w-sm cursor-pointer overflow-hidden rounded-lg border bg-muted/40 transition-opacity hover:opacity-80${warning ? " border-amber-500/60" : ""}`}
      >
        {/*
          <embed> with `pointer-events: none` keeps clicks bubbling to the
          DialogTrigger button instead of being swallowed by the PDF viewer's
          own UI inside the iframe-equivalent.
         */}
        <embed src={url} type="application/pdf" className="pointer-events-none block h-40 w-64" />
        <div className="flex items-center gap-2 border-t bg-background px-3 py-1.5">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{filename}</span>
        </div>
      </button>
    </PdfDialog>
    {warning && <CapabilityWarning message={warning} />}
  </div>
);

const ImagePreview: FC<{ url: string; filename: string; warning: string | null }> = ({
  url,
  filename,
  warning,
}) => (
  <div>
    <Dialog>
      <DialogTrigger
        aria-label={`Preview ${filename}`}
        className={`my-2 block cursor-pointer rounded-lg transition-opacity hover:opacity-80${warning ? " outline outline-2 outline-amber-500/60" : ""}`}
      >
        <img
          src={url}
          alt={`Attachment: ${filename}`}
          className="max-h-64 max-w-sm rounded-lg object-contain"
        />
      </DialogTrigger>
      <DialogContent
        className="p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:bg-foreground/60 [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0! [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{filename}</DialogTitle>
        <img
          src={url}
          alt={`Attachment: ${filename}`}
          className="block h-auto max-h-[80dvh] w-auto max-w-full object-contain"
        />
      </DialogContent>
    </Dialog>
    {warning && <CapabilityWarning message={warning} />}
  </div>
);

const Probing: FC<{ filename: string }> = ({ filename }) => (
  <div
    className="my-2 flex max-w-sm items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2"
    aria-label={`Preparing preview of ${filename}`}
    aria-busy="true"
  >
    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
    <span className="truncate text-sm text-muted-foreground">{filename}</span>
  </div>
);

const Chip: FC<{
  filename: string | undefined;
  mimeType: string;
  warning?: string | null;
  /** Where the file downloads from; without it the chip only names the file. */
  href?: string;
}> = ({ filename, mimeType, warning, href }) => {
  const label = filename ?? (mimeType === "application/pdf" ? "PDF document" : "File");
  const className = `my-1 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2${warning ? " border-amber-500/60" : ""}`;
  return (
    <div>
      {href ? (
        // `download` because the routes serve `inline`: without it a CSV opens
        // as text in the tab. Left without a value so the Content-Disposition
        // filename, which carries umlauts intact, still names the saved file.
        <a
          href={href}
          download
          aria-label={`Download ${label}`}
          className={`${className} max-w-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        >
          <FileText className="size-5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{label}</span>
          <Download className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </a>
      ) : (
        <div className={className}>
          <FileText className="size-5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{label}</span>
        </div>
      )}
      {warning && <CapabilityWarning message={warning} />}
    </div>
  );
};
