"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock, Send } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import { buildBundleFilename, downloadBundle } from "@/lib/diagnostics/download";
import type { DiagnosticsExportRequest } from "@/lib/schemas/diagnostics";
import type { ChatListItem } from "@/lib/schemas/sessions";

import { DiagnosticsWhatsIncluded } from "./diagnostics-whats-included";

const USER_DESCRIPTION_MAX = 500;

/** Title to show for a chat — the saved label, or a date-stamped fallback. */
function chatTitle(item: ChatListItem): string {
  if (item.title && item.title.trim().length > 0) return item.title;
  return `Chat from ${new Date(item.lastInteractionAt).toLocaleDateString()}`;
}

/**
 * Which listed chat should be selected by default. From chat context we match
 * the active chat by `chatId` (`null` = the default/legacy chat); from Settings
 * (`chatId` undefined) we fall back to the default chat too. Returns the chat's
 * sessionId, or `null` when no web chat matches (→ the export route's default
 * path). Telegram chats are never a default target — they're opt-in via the picker.
 */
function initialSessionId(chats: ChatListItem[], chatId: string | null): string | null {
  const match = chats.find((c) => c.origin === "web" && c.chatId === chatId);
  return match?.sessionId ?? null;
}

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

export function DiagnosticsExportDialog({
  open,
  agentId,
  agentName,
  anchorMessageId,
  chatId,
  onClose,
}: DiagnosticsExportDialogProps) {
  const [userDescription, setUserDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [whatsIncludedOpen, setWhatsIncludedOpen] = useState(false);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Fetch the user's chats when the dialog opens so they can pick which chat to
  // export (#639), preselecting the active/default one. A failed fetch degrades
  // to no picker → the export route's default-chat path — reporting a bug is a
  // convenience path, never blocked on the chat list.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiGet<{ chats: ChatListItem[] }>(`/api/agents/${agentId}/chats`)
      .then((res) => {
        if (cancelled) return;
        const list = res.chats ?? [];
        setChats(list);
        setSelectedSessionId(initialSessionId(list, chatId ?? null));
      })
      .catch(() => {
        if (cancelled) return;
        setChats([]);
        setSelectedSessionId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, agentId, chatId]);

  function handleOpenChange(next: boolean) {
    if (!next && !submitting) {
      // Reset transient state so reopening the dialog starts clean.
      setUserDescription("");
      setValidationError(null);
      setWhatsIncludedOpen(false);
      setChats([]);
      setSelectedSessionId(null);
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
    // Omit sessionId when none is selected so the route takes its default-chat
    // path (unchanged behaviour for users with no listable chats).
    if (selectedSessionId) {
      body.sessionId = selectedSessionId;
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
          {anchorMessageId && (
            <div
              role="note"
              className="rounded-md border border-amber-500/40 bg-amber-50/60 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            >
              Per-message reporting is in beta — this export includes your last 10 turns rather than
              a slice anchored on the specific message you clicked.
            </div>
          )}
          {chats.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="diagnostics-chat-select">Chat to export</Label>
              <Select
                value={selectedSessionId ?? undefined}
                onValueChange={(v) => setSelectedSessionId(v)}
              >
                <SelectTrigger id="diagnostics-chat-select" aria-label="Chat to export">
                  <SelectValue placeholder="Select a chat" />
                </SelectTrigger>
                <SelectContent>
                  {chats.map((c) => (
                    <SelectItem key={c.sessionId} value={c.sessionId}>
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{chatTitle(c)}</span>
                        {c.origin === "telegram" && (
                          <Send className="size-3 shrink-0 opacity-70" aria-label="Telegram" />
                        )}
                        {!c.writable && (
                          <Lock className="size-3 shrink-0 opacity-70" aria-label="Read-only" />
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
            className="text-sm text-primary-accent underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
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
