"use client";

import { useContext, useState, type FC, type PropsWithChildren } from "react";
import { AddPendingUploadContext } from "@/components/chat";
import { cn } from "@/lib/utils";

/**
 * Drop target for the composer that routes every dropped file through the
 * two-phase upload pipeline (`addPendingUpload`). Replaces assistant-ui's
 * `ComposerPrimitive.AttachmentDropzone` for binary/image attachments — the
 * legacy dropzone funnelled files through adapters that emit base64
 * `image_url` content parts, which the server now rejects with
 * `PROTOCOL_OUTDATED`.
 */
export const PinchyDropZone: FC<PropsWithChildren<{ className?: string }>> = ({
  children,
  className,
}) => {
  const addPendingUpload = useContext(AddPendingUploadContext);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      data-testid="pinchy-drop-zone"
      data-dragging={isDragging ? "true" : undefined}
      className={cn(
        "data-[dragging=true]:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-accent/50",
        className
      )}
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={(e) => {
        // Browsers default-handle dragover by trying to navigate to the file
        // when dropped. Always prevent that, even when the drag is unrelated —
        // a stray missed `Files` check would leak the user out of the chat.
        e.preventDefault();
      }}
      onDragLeave={() => {
        setIsDragging(false);
      }}
      // Belt-and-suspenders: dragleave can be missed when the user drags out
      // of the window, switches tabs mid-drag, or releases over a child that
      // stopPropagation()s its own dragend. dragend fires on the *source*
      // element after every drag (success or cancel), so listening for it on
      // the drop zone catches any source-side drag that ended while we still
      // had the dashed-border state set. Without this fallback the styling
      // can linger until the next dragenter.
      onDragEnd={() => {
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        for (const file of Array.from(files)) {
          addPendingUpload(file);
        }
      }}
    >
      {children}
    </div>
  );
};
