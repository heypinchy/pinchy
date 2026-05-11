"use client";

import { useContext, useEffect, useRef, useState, type FC } from "react";
import { useMessagePartFile } from "@assistant-ui/react";
import { FileText, Loader2 } from "lucide-react";
import { AgentIdContext } from "@/components/chat";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/**
 * URL the browser fetches the uploaded file from. Filename is encoded so
 * spaces / parentheses / unicode all survive — the route handler decodes it
 * back via Next's params resolution.
 */
function buildUploadUrl(agentId: string, filename: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/uploads/${encodeURIComponent(filename)}`;
}

// Why a probe + retry? The server persists the uploaded file AFTER the WS
// message lands (processIncomingAttachments runs the buffer write inline),
// but the browser renders this component as soon as the user message hits
// local state. A naive <embed src=…> hits the GET route before the file is
// on disk and the browser paints "Not found". Page reload works only because
// the message then replays from OpenClaw history with the file already there.
// The structural fix lives in #324 (multipart pre-upload); this probe is the
// hotfix that papers over the race for v0.5.3.
const PROBE_SCHEDULE_MS = [200, 400, 800, 1600] as const;

type ProbeState = "probing" | "ready" | "failed";

/**
 * Polls `HEAD <url>` with exponential backoff until the server returns a 2xx
 * (file is on disk and serveable) or the schedule is exhausted. The first
 * probe fires synchronously on mount so the happy path — reload, file already
 * persisted — finishes in one round trip.
 *
 * Cancellation is via AbortController so a fast unmount or url change does
 * not race the previous probe's setState into a discarded tree.
 */
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
        // Network error counts as a failed probe — same backoff as 404.
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
 * Renders an attachment chip next to a chat message bubble. Branches by MIME:
 *
 * - `application/pdf` → small `<embed>` thumbnail; click opens a modal with
 *   the browser's native PDF viewer at full size.
 * - `image/*` → inline `<img>`; click opens a modal with the full image.
 * - anything else (or missing agentId / filename) → a plain chip.
 *
 * For media previews the URL is HEAD-probed first to avoid the v0.5.3 race
 * described on `useUploadReadiness`. The plain-chip path skips the probe
 * because it never renders the URL.
 */
export const AttachmentPreview: FC = () => {
  const { mimeType, filename } = useMessagePartFile();
  const agentId = useContext(AgentIdContext);

  const isPreviewable =
    !!agentId && !!filename && (mimeType === "application/pdf" || mimeType.startsWith("image/"));
  const url = isPreviewable ? buildUploadUrl(agentId!, filename!) : null;
  const readiness = useUploadReadiness(url);

  // Falls back to a chip when we don't have everything we need to build a URL.
  if (!agentId || !filename) {
    return <Chip filename={filename} mimeType={mimeType} />;
  }

  // Probe budget exhausted → render the chip so the message still shows the
  // filename and does not silently look attachment-less. A page reload re-runs
  // the probe against the (by then persisted) file.
  if (readiness === "failed") {
    return <Chip filename={filename} mimeType={mimeType} />;
  }

  if (mimeType === "application/pdf") {
    if (readiness === "probing") return <Probing filename={filename} />;
    return <PdfPreview url={url!} filename={filename} />;
  }
  if (mimeType.startsWith("image/")) {
    if (readiness === "probing") return <Probing filename={filename} />;
    return <ImagePreview url={url!} filename={filename} />;
  }
  return <Chip filename={filename} mimeType={mimeType} />;
};

const PdfPreview: FC<{ url: string; filename: string }> = ({ url, filename }) => (
  <Dialog>
    <DialogTrigger
      aria-label={`Preview ${filename}`}
      className="my-2 block max-w-sm cursor-pointer overflow-hidden rounded-lg border bg-muted/40 transition-opacity hover:opacity-80"
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
    </DialogTrigger>
    <DialogContent
      className="p-2 sm:max-w-4xl [&>button]:rounded-full [&>button]:bg-foreground/60 [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0! [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive"
      aria-describedby={undefined}
    >
      <DialogTitle className="sr-only">{filename}</DialogTitle>
      <embed src={url} type="application/pdf" className="block h-[80dvh] w-full" />
    </DialogContent>
  </Dialog>
);

const ImagePreview: FC<{ url: string; filename: string }> = ({ url, filename }) => (
  <Dialog>
    <DialogTrigger
      aria-label={`Preview ${filename}`}
      className="my-2 block cursor-pointer rounded-lg transition-opacity hover:opacity-80"
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

const Chip: FC<{ filename: string | undefined; mimeType: string }> = ({ filename, mimeType }) => {
  const label = filename ?? (mimeType === "application/pdf" ? "PDF document" : "File");
  return (
    <div className="my-1 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <FileText className="size-5 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm">{label}</span>
    </div>
  );
};
