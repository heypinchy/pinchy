"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Send, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatSwitcher } from "@/components/chat-switcher";
import { apiGet, ApiError } from "@/lib/api-client";
import type { TelegramTranscriptMessage } from "@/lib/schemas/sessions";

interface TelegramChatViewProps {
  agentId: string;
  agentName: string;
  avatarUrl?: string;
  isPersonal?: boolean;
  canEdit?: boolean;
}

interface TelegramChatResponse {
  messages: TelegramTranscriptMessage[];
  botDeepLink: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "empty" } // no linked Telegram conversation (404)
  | { kind: "error" }
  | { kind: "ready"; data: TelegramChatResponse };

/** Best-effort local time stamp; empty when OpenClaw omitted the timestamp. */
function formatTimestamp(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * One read-only transcript bubble. Mirrors the live chat's bubble styling
 * (`thread.tsx`): user turns sit right-aligned in a muted pill, assistant
 * turns read as left-aligned prose. `data-role` keeps the role assertable in
 * tests and available for styling.
 */
function TranscriptMessage({
  message,
  index,
}: {
  message: TelegramTranscriptMessage;
  index: number;
}) {
  const isUser = message.role === "user";
  const timestamp = formatTimestamp(message.timestamp);
  return (
    <div
      data-testid={`telegram-message-${index}`}
      data-role={message.role}
      className={`mx-auto flex w-full max-w-2xl flex-col px-2 py-3 ${
        isUser ? "items-end" : "items-start"
      }`}
    >
      {isUser ? (
        <div className="wrap-break-word rounded-2xl bg-muted px-4 py-2.5 text-foreground whitespace-pre-wrap">
          {message.text}
        </div>
      ) : (
        <div className="wrap-break-word px-2 text-foreground leading-relaxed whitespace-pre-wrap">
          {message.text}
        </div>
      )}
      {timestamp && <span className="text-muted-foreground mt-1 px-2 text-xs">{timestamp}</span>}
    </div>
  );
}

/**
 * Read-only mirror of the user's Telegram conversation with an agent (#508).
 *
 * The conversation itself lives in Telegram — this view fetches a static
 * transcript on mount and renders it without a composer. A banner where the
 * composer would normally be makes the read-only nature obvious and offers a
 * "Continue on Telegram" deep link back to the bot.
 */
export function TelegramChatView({
  agentId,
  agentName,
  avatarUrl,
  isPersonal = false,
  canEdit = false,
}: TelegramChatViewProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    apiGet<TelegramChatResponse>(`/api/agents/${agentId}/telegram-chat`)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 404 means the user has no linked Telegram conversation — that's an
        // empty state, not a failure.
        if (err instanceof ApiError && err.status === 404) {
          setState({ kind: "empty" });
        } else {
          setState({ kind: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <header
        data-testid="telegram-chat-header"
        className="flex p-4 border-b items-center justify-between shrink-0"
      >
        <div className="flex items-center gap-2 min-w-0">
          {avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="size-7 rounded-full shrink-0" />
          )}
          <ChatSwitcher agentId={agentId} chatId={null} agentName={agentName} activeTelegram />
          <Badge variant="outline" className="text-xs font-normal">
            {isPersonal ? "Private" : "Shared"}
          </Badge>
          <Badge
            data-testid="telegram-channel-indicator"
            variant="secondary"
            className="gap-1 text-xs font-normal"
          >
            <Send className="size-3" aria-hidden="true" />
            Telegram
          </Badge>
        </div>
        {canEdit && (
          <Link
            href={`/chat/${agentId}/settings`}
            aria-label="Settings"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="size-5" />
          </Link>
        )}
      </header>

      <div data-testid="telegram-chat-body" className="flex-1 min-h-0 overflow-y-auto">
        {state.kind === "loading" && (
          <p className="text-muted-foreground p-6 text-center text-sm">
            Loading your Telegram conversation…
          </p>
        )}

        {state.kind === "empty" && (
          <p className="text-muted-foreground p-6 text-center text-sm">
            No Telegram conversation linked yet.
          </p>
        )}

        {state.kind === "error" && (
          <p className="text-destructive p-6 text-center text-sm">
            We couldn&apos;t load your Telegram conversation. Please try again.
          </p>
        )}

        {state.kind === "ready" && (
          <div data-testid="telegram-transcript" className="py-4">
            {state.data.messages.length === 0 ? (
              <p className="text-muted-foreground p-6 text-center text-sm">
                This Telegram conversation is empty so far.
              </p>
            ) : (
              state.data.messages.map((message, index) => (
                <TranscriptMessage key={index} message={message} index={index} />
              ))
            )}
          </div>
        )}
      </div>

      {/* The composer's spot — a banner instead, since this view is read-only. */}
      {state.kind === "ready" && (
        <div className="border-t bg-muted/30 px-4 py-3 shrink-0">
          <div className="mx-auto flex max-w-2xl flex-col items-center gap-2 text-center sm:flex-row sm:justify-between sm:text-left">
            <p className="text-muted-foreground text-sm">
              This conversation happens on Telegram. You&apos;re reading it here.
            </p>
            {state.data.botDeepLink && (
              <Button asChild size="sm" className="shrink-0">
                <a href={state.data.botDeepLink} target="_blank" rel="noopener noreferrer">
                  Continue on Telegram
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
