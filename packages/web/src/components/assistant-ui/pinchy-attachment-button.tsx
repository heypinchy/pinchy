"use client";

import { type FC, useContext, useRef } from "react";
import { PlusIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { AddPendingUploadContext } from "@/components/chat";
import { INPUT_ACCEPT_ATTRIBUTE } from "@/lib/attachment-mime";

/**
 * Composer button that routes picked files into the two-phase upload pipeline
 * (`addPendingUpload`), bypassing assistant-ui's adapter chain. Replaces the
 * legacy `ComposerAddAttachment` for binary/image attachments — the legacy
 * path produced base64 `image_url` content parts that the server now rejects
 * with `PROTOCOL_OUTDATED`.
 */
export const PinchyAttachmentButton: FC = () => {
  const addPendingUpload = useContext(AddPendingUploadContext);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment size-8.5 rounded-full p-1 font-semibold text-xs hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30"
        aria-label="Add Attachment"
        onClick={() => inputRef.current?.click()}
      >
        <PlusIcon className="aui-attachment-add-icon size-5 stroke-[1.5px]" />
      </TooltipIconButton>
      <input
        ref={inputRef}
        type="file"
        data-testid="pinchy-attachment-input"
        accept={INPUT_ACCEPT_ATTRIBUTE}
        multiple
        hidden
        onChange={(e) => {
          const files = e.target.files;
          if (!files) return;
          for (const file of Array.from(files)) {
            addPendingUpload(file);
          }
          // Reset so picking the exact same file twice still fires `change`.
          e.target.value = "";
        }}
      />
    </>
  );
};
