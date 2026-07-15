"use client";

import { type ComponentProps, type FC, useContext } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import { AddPendingUploadContext } from "@/components/chat";

/**
 * Composer textarea that routes pasted files (screenshots via Cmd+V or
 * right-click → Paste, files copied from the file manager) into the two-phase
 * upload pipeline (`addPendingUpload`). The sibling of PinchyAttachmentButton
 * (picked files) and PinchyDropZone (dropped files) for the third intake path.
 *
 * `addAttachmentOnPaste={false}` is load-bearing: assistant-ui's built-in paste
 * handler routes files through `CompositeAttachmentAdapter`, which no longer
 * carries an image adapter — pasting a screenshot threw "No matching adapter
 * found for file" into its own try/catch and dropped the paste silently. Left
 * enabled it would also double-attach any MIME the chain still accepts, once
 * per path.
 */
export const PinchyComposerInput: FC<ComponentProps<typeof ComposerPrimitive.Input>> = ({
  onPaste,
  ...props
}) => {
  const addPendingUpload = useContext(AddPendingUploadContext);

  return (
    <ComposerPrimitive.Input
      {...props}
      addAttachmentOnPaste={false}
      onPaste={(e) => {
        onPaste?.(e);
        if (e.defaultPrevented) return;

        const files = Array.from(e.clipboardData?.files ?? []);
        // No files means an ordinary text paste — leave it to the browser.
        if (files.length === 0) return;

        // Suppress the default so a file paste that also carries a text
        // flavor (the filename, or the source page's HTML) does not dump that
        // text into the message box alongside the attachment.
        e.preventDefault();
        for (const file of files) {
          addPendingUpload(file);
        }
      }}
    />
  );
};
