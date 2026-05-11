"use client";

import { useContext, useEffect, useRef, useState, type FC } from "react";
import { useMessagePartFile } from "@assistant-ui/react";
import { FileText, Loader2 } from "lucide-react";
import { AgentIdContext } from "@/components/chat";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { requiredCapabilityForFile } from "@/lib/attachment-capability";

// See a32cd2c7b for the probe rationale (HEAD-probe the upload URL before
// mounting <embed>/<img> to avoid the post-WS-message file-not-yet-persisted
// race on v0.5.3). The main race is resolved by multipart pre-upload (#324)
// but the probe stays as a defence against server-side dedup delays.
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

export type ModelCapabilities = {
  vision: boolean;
  documents: boolean;
  audio: boolean;
  video: boolean;
  longContext: boolean;
  tools: boolean;
};

/**
 * URL the browser fetches the uploaded file from. Filename is encoded so
 * spaces / parentheses / unicode all survive — the route handler decodes it
 * back via Next's params resolution.
 */
function buildUploadUrl(agentId: string, filename: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/uploads/${encodeURIComponent(filename)}`;
}

/**
 * Renders an attachment chip next to a chat message bubble. Branches by MIME:
 *
 * - `application/pdf` → small `<embed>` thumbnail; click opens a modal with
 *   the browser's native PDF viewer at full size.
 * - `image/*` → inline `<img>`; click opens a modal with the full image.
 * - anything else (or missing agentId / filename) → a plain chip.
 */
type AttachmentPreviewProps = {
  modelCapabilities?: ModelCapabilities | null;
};

export const AttachmentPreview: FC<AttachmentPreviewProps> = ({ modelCapabilities }) => {
  const { mimeType, filename } = useMessagePartFile();
  const agentId = useContext(AgentIdContext);

  const isPreviewable =
    !!agentId && !!filename && (mimeType === "application/pdf" || mimeType.startsWith("image/"));
  const url = isPreviewable ? buildUploadUrl(agentId!, filename!) : null;
  const readiness = useUploadReadiness(url);

  const requiredCapability = requiredCapabilityForFile(mimeType);
  const capabilityWarning =
    modelCapabilities && requiredCapability && !modelCapabilities[requiredCapability]
      ? requiredCapability === "vision"
        ? "This model doesn't support image input."
        : "This model doesn't support document input."
      : null;

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

const PdfPreview: FC<{ url: string; filename: string; warning: string | null }> = ({
  url,
  filename,
  warning,
}) => (
  <div>
    <Dialog>
      <DialogTrigger
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
      </DialogTrigger>
      <DialogContent
        className="p-2 sm:max-w-4xl [&>button]:rounded-full [&>button]:bg-foreground/60 [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0! [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{filename}</DialogTitle>
        <embed src={url} type="application/pdf" className="block h-[80dvh] w-full" />
      </DialogContent>
    </Dialog>
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
