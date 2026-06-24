"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useChatSessionIsRunning } from "@/components/chat-session-provider";
import { useRunCompletionEffect } from "@/hooks/use-run-completion-effect";

interface ChatSwitcherProps {
  agentId: string;
  /** The active chat from the URL, or null for the default/legacy chat. */
  chatId: string | null;
  agentName: string;
  /**
   * True when the switcher is rendered on the read-only Telegram view
   * (`/chat/<agentId>/telegram`). The Telegram view has no `chatId` of its own,
   * so the URL-derived `isActive` (web-only) can't recognize it — this flag
   * tells the switcher to mark the Telegram row active instead.
   */
  activeTelegram?: boolean;
}

/**
 * Whether `item` is the chat the URL currently points at.
 *
 * Web chats match by `chatId` (`/chat/<agentId>` → default, `/chat/<agentId>/<id>`
 * → specific). Telegram chats live at the dedicated `/chat/<agentId>/telegram`
 * view and carry `chatId: null`, so they'd otherwise collide with the default
 * web chat — they are only active when `activeTelegram` is set.
 */
function isActive(item: ChatListItem, chatId: string | null, activeTelegram: boolean): boolean {
  if (item.origin === "telegram") return activeTelegram;
  return item.chatId === chatId && !activeTelegram;
}

/** Title to show for a chat — the saved label, or a date-stamped fallback. */
function chatTitle(item: ChatListItem): string {
  if (item.title && item.title.trim().length > 0) return item.title;
  return `Chat from ${new Date(item.lastInteractionAt).toLocaleDateString()}`;
}

/** sessionId we tag the optimistic current-chat row with (it has no real OpenClaw session yet). */
const SYNTHETIC_CURRENT_SESSION_ID = "__optimistic-current__";

/**
 * Ensure the chat the URL currently points at is ALWAYS in the list, even
 * before its first message creates an OpenClaw session (standard ChatGPT/Claude
 * behaviour). If the server list already contains the current web chat we use
 * that entry as-is; otherwise we prepend a synthetic "New chat" row so the user
 * always sees where they are. Telegram is never synthesized — its sessions are
 * created in Telegram, not here.
 */
function withOptimisticCurrentChat(
  chats: ChatListItem[],
  chatId: string | null,
  activeTelegram: boolean
): ChatListItem[] {
  // On the Telegram view the active chat is a real telegram session, so there
  // is no web chat to synthesize.
  if (activeTelegram) return chats;

  const alreadyListed = chats.some((c) => c.origin === "web" && c.chatId === chatId);
  if (alreadyListed) return chats;

  const synthetic: ChatListItem = {
    chatId,
    sessionId: SYNTHETIC_CURRENT_SESSION_ID,
    origin: "web",
    writable: true,
    title: "New chat",
    // A stable "always newest" sentinel (not Date.now(), which is impure in
    // render) so the brand-new chat sorts to the top of the recency-ordered
    // list. The dropdown shows relative-time per row but the current chat is
    // expected at the top regardless.
    lastInteractionAt: Number.MAX_SAFE_INTEGER,
  };
  return [synthetic, ...chats];
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
export function ChatSwitcher({
  agentId,
  chatId,
  agentName,
  activeTelegram = false,
}: ChatSwitcherProps) {
  const router = useRouter();
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Re-fetch the chat list on each load. Returns a cleanup-aware fetch so both
  // the mount effect and the open handler can ignore a settled result after the
  // component unmounts. A failed fetch degrades quietly to the empty state
  // rather than blocking the header.
  const loadChats = useCallback(() => {
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

  // Fetch once on mount so the trigger label reflects the active chat's title
  // without the user having to open the dropdown. `isLoading` starts true via
  // useState so we don't re-set it here (keeps the effect free of a synchronous
  // setState — react-hooks/set-state-in-effect).
  useEffect(() => loadChats(), [loadChats]);

  // Refresh the list the moment the active chat's run finishes, so the server-
  // derived title (from the first user message) appears immediately. Without
  // this a brand-new chat keeps showing the agent name in the header until the
  // dropdown is reopened or the agent is switched.
  const isRunning = useChatSessionIsRunning(agentId, chatId ?? undefined);
  useRunCompletionEffect(isRunning, loadChats);

  // Re-fetch every time the dropdown opens so sessions created since mount (e.g.
  // by a message just sent in the active chat) appear. The result is discarded
  // on close, so there's nothing to clean up here.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) loadChats();
    },
    [loadChats]
  );

  // Always include the current chat — optimistically as "New chat" when it has
  // no OpenClaw session yet — sorted to the top.
  const displayChats = useMemo(
    () => withOptimisticCurrentChat(chats, chatId, activeTelegram),
    [chats, chatId, activeTelegram]
  );

  const current = displayChats.find((c) => isActive(c, chatId, activeTelegram));
  // The header trigger shows the active chat's title — but for the OPTIMISTIC
  // current row (a brand-new/default chat with no real session yet) we keep the
  // agent name in the persistent header rather than a generic "New chat"; the
  // dropdown still lists that row as "New chat". On the Telegram view the active
  // row may not have loaded yet, so fall back to a literal "Telegram" label.
  const currentIsOptimistic = current?.sessionId === SYNTHETIC_CURRENT_SESSION_ID;
  const triggerLabel =
    current && !currentIsOptimistic
      ? chatTitle(current)
      : activeTelegram
        ? "Telegram"
        : (agentName ?? "Chat");

  function startNewChat() {
    router.push(`/chat/${agentId}/${generateChatId()}`);
  }

  function openChat(item: ChatListItem) {
    // Telegram chats open the dedicated read-only mirror; web chats open their
    // own session (or the default chat when chatId is null).
    if (item.origin === "telegram") {
      router.push(`/chat/${agentId}/telegram`);
      return;
    }
    router.push(item.chatId ? `/chat/${agentId}/${item.chatId}` : `/chat/${agentId}`);
  }

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto min-w-0 shrink gap-1.5 px-2 py-1">
          <span className="min-w-0 truncate font-bold">{triggerLabel}</span>
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
        ) : displayChats.length === 0 ? (
          <DropdownMenuLabel className="text-muted-foreground font-normal">
            No other chats yet
          </DropdownMenuLabel>
        ) : (
          displayChats.map((item) => {
            const active = isActive(item, chatId, activeTelegram);
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
                    {item.sessionId === SYNTHETIC_CURRENT_SESSION_ID
                      ? "Not saved yet"
                      : relativeTime(item.lastInteractionAt)}
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
