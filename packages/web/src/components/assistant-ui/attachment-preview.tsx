"use client";

import { useContext, type FC } from "react";
import { useMessagePartFile } from "@assistant-ui/react";
import { FileText } from "lucide-react";
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

/**
 * Renders an attachment chip next to a chat message bubble. Branches by MIME:
 *
 * - `application/pdf` → small `<embed>` thumbnail; click opens a modal with
 *   the browser's native PDF viewer at full size.
 * - `image/*` → inline `<img>`; click opens a modal with the full image.
 * - anything else (or missing agentId / filename) → a plain chip.
 *
 * The chip has zero JS dependencies — keeps the bundle thin and degrades
 * gracefully if the API endpoint is unreachable.
 */
export const AttachmentPreview: FC = () => {
  const { mimeType, filename } = useMessagePartFile();
  const agentId = useContext(AgentIdContext);

  // Falls back to a chip when we don't have everything we need to build a URL.
  if (!agentId || !filename) {
    return <Chip filename={filename} mimeType={mimeType} />;
  }

  const url = buildUploadUrl(agentId, filename);

  if (mimeType === "application/pdf") {
    return <PdfPreview url={url} filename={filename} />;
  }
  if (mimeType.startsWith("image/")) {
    return <ImagePreview url={url} filename={filename} />;
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
    <DialogContent className="p-2 sm:max-w-4xl">
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
    <DialogContent className="p-2 sm:max-w-3xl">
      <DialogTitle className="sr-only">{filename}</DialogTitle>
      <img
        src={url}
        alt={`Attachment: ${filename}`}
        className="block h-auto max-h-[80vh] w-auto max-w-full object-contain"
      />
    </DialogContent>
  </Dialog>
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
