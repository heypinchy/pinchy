"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, Loader2, Lock, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { chatTitle } from "@/lib/chats/chat-title";
import { buildBundleFilename, downloadBundle } from "@/lib/diagnostics/download";
import type { DiagnosticsExportRequest } from "@/lib/schemas/diagnostics";
import type { ChatListItem } from "@/lib/schemas/sessions";
import { cn } from "@/lib/utils";

import { DiagnosticsWhatsIncluded } from "./diagnostics-whats-included";

const USER_DESCRIPTION_MAX = 500;

/**
 * Which listed chat should be selected by default. From chat context we match
 * the active chat by `chatId` (`null` = the default/legacy chat); from Settings
 * (`chatId` undefined) we prefer the default chat. When neither is present —
 * e.g. a user with only named chats, or an active chat not yet in the list — we
 * fall back to the most-recent listed chat (the server returns them newest
 * first) rather than leaving the picker unselected, which would silently export
 * the default chat (or 404) despite a populated dropdown. Returns `null` only
 * for an empty list. Telegram chats are never the auto-match but can be the
 * newest-first fallback and are always opt-in via the picker.
 */
function initialSessionId(chats: ChatListItem[], chatId: string | null): string | null {
  const match = chats.find((c) => c.origin === "web" && c.chatId === chatId);
  return match?.sessionId ?? chats[0]?.sessionId ?? null;
}

export interface DiagnosticsExportFormProps {
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
  submitLabel?: string;
  /**
   * Renders a Cancel button next to submit. Only the dialog surface has
   * somewhere to cancel back to, so its presence also right-aligns the actions
   * into a dialog footer row; inline they sit left under the fields.
   */
  onCancel?: () => void;
  /** Called after the bundle has downloaded. */
  onExported?: () => void;
  /**
   * Reports whether an export is in flight, so a surrounding surface can refuse
   * to disappear mid-request — the dialog blocks Escape and overlay clicks.
   */
  onSubmittingChange?: (submitting: boolean) => void;
  className?: string;
}

/**
 * The diagnostics export form: pick a chat, describe the problem, download a
 * bundle. Shared by the two surfaces that offer it — inline on Agent Settings →
 * Diagnostics, and inside a dialog for per-message "Report issue to support" in
 * chat, where the user must not lose their place in the conversation.
 *
 * Owns all transient state, so the dialog gets a clean form on every open
 * simply by unmounting its content on close.
 */
export function DiagnosticsExportForm({
  agentId,
  agentName,
  anchorMessageId,
  chatId,
  submitLabel = "Generate",
  onCancel,
  onExported,
  onSubmittingChange,
  className,
}: DiagnosticsExportFormProps) {
  const fieldId = useId();
  const chatSelectId = `${fieldId}-chat`;
  const descriptionId = `${fieldId}-description`;
  const errorId = `${fieldId}-error`;

  const [userDescription, setUserDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Fetch the user's chats so they can pick which one to export (#639),
  // preselecting the active/default one. A failed fetch degrades to no picker →
  // the export route's default-chat path — reporting a bug is a convenience
  // path, never blocked on the chat list.
  useEffect(() => {
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
  }, [agentId, chatId]);

  function updateSubmitting(next: boolean) {
    setSubmitting(next);
    onSubmittingChange?.(next);
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
    updateSubmitting(true);

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
      const filename = buildBundleFilename(agentName, new Date());
      downloadBundle(bundle, filename);
      updateSubmitting(false);
      setUserDescription("");
      setValidationError(null);
      // The download is silent — the browser may drop the file straight into
      // the downloads folder with nothing visible. Inline there isn't even a
      // dialog whose closing would signal success, only a description quietly
      // blanking itself. Name the file so it can be found.
      toast.success("Diagnostics export downloaded", { description: filename });
      onExported?.();
    } catch (e) {
      updateSubmitting(false);
      const message =
        e instanceof ApiError ? e.message : "Failed to generate diagnostics. Please try again.";
      toast.error(message);
    }
  }

  return (
    <div className={cn("min-w-0 space-y-4", className)}>
      {anchorMessageId && (
        <div
          role="note"
          className="rounded-md border border-amber-500/40 bg-amber-50/60 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          Per-message reporting is in beta — this export includes your last 10 turns rather than a
          slice anchored on the specific message you clicked.
        </div>
      )}

      {chats.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor={chatSelectId}>Chat to export</Label>
          <Select value={selectedSessionId ?? undefined} onValueChange={setSelectedSessionId}>
            {/* `w-full min-w-0` overrides the trigger's default `w-fit`, which
                sizes to the chat title and would otherwise spill the picker out
                of the dialog on a long one. */}
            <SelectTrigger id={chatSelectId} aria-label="Chat to export" className="w-full min-w-0">
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
        <Label htmlFor={descriptionId}>What went wrong? (optional)</Label>
        <Textarea
          id={descriptionId}
          placeholder="What went wrong? (optional)"
          value={userDescription}
          onChange={(e) => {
            setUserDescription(e.target.value);
            if (validationError) setValidationError(null);
          }}
          rows={4}
          maxLength={USER_DESCRIPTION_MAX * 2}
          aria-invalid={validationError ? true : undefined}
          aria-describedby={validationError ? errorId : undefined}
        />
        {validationError && (
          <p id={errorId} className="text-sm text-destructive">
            {validationError}
          </p>
        )}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-primary-accent underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none">
          What&apos;s included?
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <DiagnosticsWhatsIncluded />
        </CollapsibleContent>
      </Collapsible>

      <div className={cn("flex flex-col-reverse gap-2 sm:flex-row", onCancel && "sm:justify-end")}>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="button" onClick={handleGenerate} disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating...
            </>
          ) : (
            submitLabel
          )}
        </Button>
      </div>
    </div>
  );
}
