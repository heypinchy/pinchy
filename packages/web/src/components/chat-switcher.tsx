"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Lock, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiGet } from "@/lib/api-client";
import type { ChatListItem } from "@/lib/schemas/sessions";
import { generateChatId } from "@/lib/chats/generate-chat-id";

interface ChatSwitcherProps {
  agentId: string;
  /** The active chat from the URL, or null for the default/legacy chat. */
  chatId: string | null;
  agentName: string;
}

/**
 * Whether `item` is the chat the URL currently points at. The active URL always
 * refers to a WEB chat (`/chat/<agentId>` → default, `/chat/<agentId>/<id>` →
 * specific), so Telegram chats are never active — even the default Telegram
 * chat carries `chatId: null` and would otherwise collide with the default web
 * chat.
 */
function isActive(item: ChatListItem, chatId: string | null): boolean {
  return item.origin === "web" && item.chatId === chatId;
}

/** Title to show for a chat — the saved label, or a date-stamped fallback. */
function chatTitle(item: ChatListItem): string {
  if (item.title && item.title.trim().length > 0) return item.title;
  return `Chat from ${new Date(item.lastInteractionAt).toLocaleDateString()}`;
}

/**
 * Short, human relative-time hint ("2h ago", "just now"). Best-effort and
 * locale-aware; we never block the list on it.
 */
function relativeTime(ms: number, now: number = Date.now()): string {
  const diffSeconds = Math.round((ms - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const divisions: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
    { amount: 60, unit: "second" },
    { amount: 60, unit: "minute" },
    { amount: 24, unit: "hour" },
    { amount: 7, unit: "day" },
    { amount: 4.34524, unit: "week" },
    { amount: 12, unit: "month" },
    { amount: Number.POSITIVE_INFINITY, unit: "year" },
  ];
  let value = diffSeconds;
  for (const division of divisions) {
    if (Math.abs(value) < division.amount) {
      return rtf.format(Math.round(value), division.unit);
    }
    value /= division.amount;
  }
  return rtf.format(Math.round(value), "year");
}

/**
 * Header dropdown that lists the user's chats with an agent (#508) and lets
 * them start a new one. Chats are fetched lazily on first open. Telegram chats
 * surface read-only — they're shown so the user can read them here, but the
 * conversation itself lives in Telegram.
 *
 * A fetch failure degrades quietly to an empty list (with a retry on the next
 * open) rather than blocking the header — switching chats is a convenience, not
 * a critical path.
 */
export function ChatSwitcher({ agentId, chatId, agentName }: ChatSwitcherProps) {
  const router = useRouter();
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch the chat list once per (agent) mount. `isLoading` starts true via
  // useState, so we don't re-set it here — that keeps the effect free of a
  // synchronous setState (react-hooks/set-state-in-effect). A failed fetch
  // degrades quietly to the empty state rather than blocking the header.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ chats: ChatListItem[] }>(`/api/agents/${agentId}/chats`)
      .then((res) => {
        if (!cancelled) setChats(res.chats ?? []);
      })
      .catch(() => {
        if (!cancelled) setChats([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const current = chats.find((c) => isActive(c, chatId));
  const triggerLabel = current ? chatTitle(current) : (agentName ?? "Chat");

  function startNewChat() {
    router.push(`/chat/${agentId}/${generateChatId()}`);
  }

  function openChat(item: ChatListItem) {
    router.push(item.chatId ? `/chat/${agentId}/${item.chatId}` : `/chat/${agentId}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto min-w-0 gap-1.5 px-2 py-1">
          <span className="truncate font-bold">{triggerLabel}</span>
          <ChevronDown className="size-4 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem onSelect={startNewChat}>
          <Plus className="size-4" />
          New chat
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {isLoading ? (
          <DropdownMenuLabel className="text-muted-foreground font-normal">
            Loading your chats…
          </DropdownMenuLabel>
        ) : chats.length === 0 ? (
          <DropdownMenuLabel className="text-muted-foreground font-normal">
            No other chats yet
          </DropdownMenuLabel>
        ) : (
          chats.map((item) => {
            const active = isActive(item, chatId);
            return (
              <DropdownMenuItem
                key={item.sessionId}
                onSelect={() => openChat(item)}
                className="flex items-start gap-2"
              >
                {active ? (
                  <Check className="size-4 shrink-0" aria-label="Current chat" />
                ) : (
                  <span className="size-4 shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{chatTitle(item)}</span>
                    {item.origin === "telegram" && (
                      <Badge variant="secondary" className="text-xs font-normal">
                        Telegram
                      </Badge>
                    )}
                    {!item.writable && (
                      <Lock
                        className="text-muted-foreground size-3 shrink-0"
                        aria-label="Read-only"
                      />
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {relativeTime(item.lastInteractionAt)}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
