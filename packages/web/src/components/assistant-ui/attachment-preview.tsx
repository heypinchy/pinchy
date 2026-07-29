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
 * - anything else (or missing agentId / filename) → a plain chip.
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
  return <Chip filename={filename} mimeType={mimeType} warning={capabilityWarning} />;
};

const CapabilityWarning: FC<{ message: string }> = ({ message }) => (
  <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">{message}</p>
);

/**
 * One "take this document" entry in the dialog header. A list rather than a
 * single url because the second entry is already on the way: once a scanned
 * Office file is converted, the same dialog offers the original beside its
 * converted PDF, and that has to be a datum rather than a redesign of the row.
 */
export type DocumentDownload = { label: string; url: string };

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
 * earns its height: it names the document (the browser's title bar shows the
 * route segment, "workspace-file", which tells a reader nothing) and it offers
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
   */
  downloads?: DocumentDownload[];
  children: ReactNode;
  /** Test-only escape hatch; the dialog is trigger-driven in the app. */
  defaultOpen?: boolean;
}> = ({ url, title, page, downloads, children, defaultOpen }) => {
  // `title` is a filename for an attachment and a full path for a citation.
  // Show the leaf either way and keep the rest in the tooltip: a corpus has
  // same-named files in different folders, so the path has to stay reachable,
  // but spending header width on it would push the controls off a narrow screen.
  const filename = title.split("/").filter(Boolean).pop() ?? title;

  const documentDownloads = downloads ?? [{ label: filename, url: downloadUrlFor(url) }];
  // With one entry the icon is unambiguous. With two it is not — "the original
  // or the converted one?" is exactly the question a bare pair of identical
  // icons refuses to answer — so each names itself as soon as there is a
  // choice to make.
  const namesDownloads = documentDownloads.length > 1;

  return (
    <Dialog defaultOpen={defaultOpen}>
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
          {page !== null && page !== undefined && (
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
            {documentDownloads.map((download) => (
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
                <a href={download.url} download aria-label={`Download ${download.label}`}>
                  <Download className="size-4" />
                  {namesDownloads && <span className="max-w-32 truncate">{download.label}</span>}
                </a>
              </Button>
            ))}
            <Button variant="ghost" size="icon" className="size-8" asChild>
              <a href={url} target="_blank" rel="noreferrer noopener" aria-label="Open in new tab">
                <ExternalLink className="size-4" />
              </a>
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Close">
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
        </div>
        {/*
          Remounted per open (the dialog unmounts its content when closed), which
          is what makes `#page=N` in the url actually land: a PDF viewer honours
          the fragment on load, not on a later fragment change.
          `min-h-0` lets this shrink inside the flex column — without it the
          embed keeps its intrinsic height and pushes the header off-screen.
         */}
        <embed src={url} type="application/pdf" className="block min-h-0 w-full flex-1" />
      </DialogContent>
    </Dialog>
  );
};

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

const Chip: FC<{ filename: string | undefined; mimeType: string; warning?: string | null }> = ({
  filename,
  mimeType,
  warning,
}) => {
  const label = filename ?? (mimeType === "application/pdf" ? "PDF document" : "File");
  return (
    <div>
      <div
        className={`my-1 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2${warning ? " border-amber-500/60" : ""}`}
      >
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{label}</span>
      </div>
      {warning && <CapabilityWarning message={warning} />}
    </div>
  );
};
