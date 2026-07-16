"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { DiagnosticsExportForm } from "./diagnostics-export-form";

export interface DiagnosticsExportDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  /** Present for per-message exports; omitted for Settings-triggered ones. */
  anchorMessageId?: string;
  /**
   * The active chat when launched from chat context (`null` = default chat).
   * Omitted (`undefined`) when launched from Settings, where the default chat
   * is preselected. Drives the picker's initial selection (#639).
   */
  chatId?: string | null;
  onClose: () => void;
}

/**
 * Modal wrapper around {@link DiagnosticsExportForm} for the per-message
 * "Report issue to support" flow in chat, where the user must not lose their
 * place in the conversation. Agent Settings → Diagnostics renders the form
 * inline instead — that tab is already the dedicated surface for this task.
 *
 * The form owns all transient state, and Radix unmounts dialog content on
 * close, so reopening always starts clean without an explicit reset.
 */
export function DiagnosticsExportDialog({
  open,
  agentId,
  agentName,
  anchorMessageId,
  chatId,
  onClose,
}: DiagnosticsExportDialogProps) {
  // An export in flight must not be closed out from under itself via Escape or
  // an overlay click — the download would be lost with no explanation.
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      {/* Capped height: the "What's included" disclosure can grow the form past
          a short viewport. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export diagnostics for {agentName}</DialogTitle>
          <DialogDescription>
            Generates a file containing your recent conversation, model and tool activity, and
            version info. Secrets and emails are automatically removed. You decide if and how to
            share it with Pinchy support.
          </DialogDescription>
        </DialogHeader>

        <DiagnosticsExportForm
          agentId={agentId}
          agentName={agentName}
          anchorMessageId={anchorMessageId}
          chatId={chatId}
          onCancel={onClose}
          onExported={onClose}
          onSubmittingChange={setSubmitting}
        />
      </DialogContent>
    </Dialog>
  );
}
