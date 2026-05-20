"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { apiPost, ApiError } from "@/lib/api-client";
import { buildBundleFilename, downloadBundle } from "@/lib/diagnostics/download";
import type { DiagnosticsExportRequest } from "@/lib/schemas/diagnostics";

import { DiagnosticsWhatsIncluded } from "./diagnostics-whats-included";

const USER_DESCRIPTION_MAX = 500;

export interface DiagnosticsExportDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  /** Present for per-message exports; omitted for Settings-triggered ones. */
  anchorMessageId?: string;
  onClose: () => void;
}

export function DiagnosticsExportDialog({
  open,
  agentId,
  agentName,
  anchorMessageId,
  onClose,
}: DiagnosticsExportDialogProps) {
  const [userDescription, setUserDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [whatsIncludedOpen, setWhatsIncludedOpen] = useState(false);

  function handleOpenChange(next: boolean) {
    if (!next && !submitting) {
      // Reset transient state so reopening the dialog starts clean.
      setUserDescription("");
      setValidationError(null);
      setWhatsIncludedOpen(false);
      onClose();
    }
  }

  async function handleGenerate() {
    const trimmed = userDescription.trim();
    if (trimmed.length > USER_DESCRIPTION_MAX) {
      setValidationError(
        `Please keep this to ${USER_DESCRIPTION_MAX} characters or fewer (currently ${trimmed.length}).`
      );
      return;
    }
    setValidationError(null);
    setSubmitting(true);

    // Build a minimal body — omit optional fields when not set so the server
    // schema sees exactly what the caller intended (the export route uses
    // `parseRequestBody` with the strict diagnostics schema).
    const body: DiagnosticsExportRequest = { agentId };
    if (anchorMessageId) {
      body.anchorMessageId = anchorMessageId;
    }
    if (trimmed.length > 0) {
      body.userDescription = trimmed;
    }

    try {
      const bundle = await apiPost<unknown, DiagnosticsExportRequest>(
        "/api/diagnostics/export",
        body
      );
      downloadBundle(bundle, buildBundleFilename(agentName, new Date()));
      setSubmitting(false);
      setUserDescription("");
      setValidationError(null);
      setWhatsIncludedOpen(false);
      onClose();
    } catch (e) {
      setSubmitting(false);
      const message =
        e instanceof ApiError ? e.message : "Failed to generate diagnostics. Please try again.";
      toast.error(message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export diagnostics for {agentName}</DialogTitle>
          <DialogDescription>
            Generates a file containing your recent conversation, model and tool activity, and
            version info. Secrets and emails are automatically removed. You decide if and how to
            share it with Pinchy support.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="diagnostics-user-description">What went wrong? (optional)</Label>
            <Textarea
              id="diagnostics-user-description"
              placeholder="What went wrong? (optional)"
              value={userDescription}
              onChange={(e) => {
                setUserDescription(e.target.value);
                if (validationError) setValidationError(null);
              }}
              rows={4}
              maxLength={USER_DESCRIPTION_MAX * 2}
              aria-invalid={validationError ? true : undefined}
              aria-describedby={validationError ? "diagnostics-user-description-error" : undefined}
            />
            {validationError && (
              <p id="diagnostics-user-description-error" className="text-sm text-destructive">
                {validationError}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setWhatsIncludedOpen(true)}
            className="text-sm text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            What&apos;s included?
          </button>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleGenerate} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              "Generate"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Nested static-content modal — content lives in its own file per the
          plan so the wording can be updated in isolation. */}
      <Dialog open={whatsIncludedOpen} onOpenChange={setWhatsIncludedOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>What&apos;s included</DialogTitle>
            <DialogDescription>Everything we package into the diagnostics file.</DialogDescription>
          </DialogHeader>
          <DiagnosticsWhatsIncluded />
          <DialogFooter>
            <Button type="button" onClick={() => setWhatsIncludedOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
