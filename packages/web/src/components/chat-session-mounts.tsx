"use client";

import { useContext, useEffect, useRef, useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useWsRuntime } from "@/hooks/use-ws-runtime";
import {
  useVisitedSessions,
  chatSessionKey,
  ChatSessionStoreContext,
} from "@/components/chat-session-provider";
import { apiPost, ApiError } from "@/lib/api-client";
import { generateChatId } from "@/lib/chats/generate-chat-id";
import { SLASH_COMMANDS, type SlashCommand } from "@/lib/slash-commands";
import type { CompactSessionRequest, ResetSessionRequest } from "@/lib/schemas/sessions";

export function ChatSessionMounts() {
  const visitedSessions = useVisitedSessions();
  // Per-session remount counter (#611). A `/reset` clears the OpenClaw session
  // in place; bumping this nonce changes the instance's React key so it
  // remounts — cold-starting useWsRuntime (fresh WS + empty history + greeting)
  // instead of surgically clearing the runtime's message state machine. Keyed
  // by the store key (agentId[:chatId]).
  const [resetNonces, setResetNonces] = useState<Record<string, number>>({});
  return (
    <>
      {visitedSessions.map(({ key, agentId, chatId }) => (
        // `key` is the composite (agentId, chatId) store key (#508). Switching
        // chats yields a new key → React remounts the instance → useWsRuntime
        // reconnects to the new session, so no stale messages bleed across. The
        // `#<nonce>` suffix lets `/reset` force a remount of THIS chat without
        // changing chatId (see resetNonces above).
        <ChatSessionInstance
          key={`${key}#${resetNonces[key] ?? 0}`}
          agentId={agentId}
          chatId={chatId}
          onSessionReset={() => setResetNonces((n) => ({ ...n, [key]: (n[key] ?? 0) + 1 }))}
        />
      ))}
    </>
  );
}

function ChatSessionInstance({
  agentId,
  chatId,
  onSessionReset,
}: {
  agentId: string;
  chatId?: string;
  onSessionReset: () => void;
}) {
  const router = useRouter();

  // Slash-command handler (#611). Each command maps to a capability Pinchy
  // already has:
  //  - /compact → existing audited compact route (summarize, keep history).
  //  - /reset   → existing reset route (clears THIS session's context in place),
  //               then remounts the thread so the user sees the clean slate.
  //  - /new     → navigate to a fresh chat (new chatId); the old one is kept.
  //  - /help    → toast listing the commands.
  // Confirmations are toasts per the error/notification policy (success →
  // toast; the toast survives the reset remount because sonner renders it
  // outside this subtree). The handler is stable across renders so
  // `useWsRuntime` doesn't churn.
  const onSlashCommand = useCallback(
    (command: SlashCommand) => {
      switch (command.name) {
        case "compact": {
          void (async () => {
            try {
              await apiPost<{ ok: boolean }, CompactSessionRequest>(
                `/api/agents/${agentId}/sessions/compact`,
                { chatId }
              );
              toast.success("Conversation compacted. It takes effect on your next message.");
            } catch (e) {
              toast.error(
                e instanceof ApiError
                  ? e.message
                  : "Couldn't compact the conversation. Please try again."
              );
            }
          })();
          break;
        }
        case "reset": {
          void (async () => {
            try {
              await apiPost<{ ok: boolean }, ResetSessionRequest>(
                `/api/agents/${agentId}/sessions/reset`,
                { chatId }
              );
              // Remount so the now-empty session is shown as a clean slate —
              // otherwise the visible messages linger while the model's context
              // is gone. `/new` is the non-destructive alternative (keeps a copy).
              onSessionReset();
              toast.success("Conversation reset — context cleared. Use New chat to keep a copy.");
            } catch (e) {
              toast.error(
                e instanceof ApiError
                  ? e.message
                  : "Couldn't reset the conversation. Please try again."
              );
            }
          })();
          break;
        }
        case "new": {
          router.push(`/chat/${agentId}/${generateChatId()}`);
          break;
        }
        case "help": {
          const lines = SLASH_COMMANDS.map((c) => `/${c.name} — ${c.description}`);
          toast.success("Slash commands", { description: lines.join("\n") });
          break;
        }
      }
    },
    [agentId, chatId, router, onSessionReset]
  );

  const bundle = useWsRuntime(agentId, chatId, onSlashCommand);

  // Access the store directly (not via useStore) so we can call publish
  // without subscribing to the bundle in the store. Subscribing to our own
  // entry would cause an infinite publish loop:
  //   publish → store update → re-render → publish → …
  const store = useContext(ChatSessionStoreContext);
  if (!store) throw new Error("ChatSessionMounts must be used within ChatSessionProvider");

  const pathname = usePathname();
  const isOnThisChat = pathname?.startsWith(`/chat/${agentId}`) ?? false;
  const previousIsRunning = useRef(false);
  const turnStartedAt = useRef<number | null>(null);

  useEffect(() => {
    if (bundle.isRunning && !previousIsRunning.current) {
      turnStartedAt.current = Date.now();
    }
    if (
      !bundle.isRunning &&
      previousIsRunning.current &&
      !isOnThisChat &&
      turnStartedAt.current !== null
    ) {
      // Turn completed while user is on a different page — fire telemetry.
      const durationMs = Date.now() - turnStartedAt.current;
      void apiPost("/api/internal/audit/background-run", { agentId, durationMs }).catch(() => {
        // Swallow errors — this is non-critical telemetry.
      });
    }
    if (!bundle.isRunning) {
      turnStartedAt.current = null;
    }
    previousIsRunning.current = bundle.isRunning;
  }, [bundle.isRunning, isOnThisChat, agentId, chatId]);

  // Capture the bundle callbacks in the effect closure. In production,
  // useWsRuntime memoizes them with useCallback so they are stable across
  // renders. The effect deps below intentionally exclude the callbacks to
  // avoid churning publishes on every render in environments (e.g. tests)
  // where the callbacks are not memoized.
  const {
    onRetryContinue,
    onRetryResend,
    addPendingUpload,
    removePendingUpload,
    retryPendingUpload,
  } = bundle;

  useEffect(() => {
    // The only sidebar-surfaced error is reconnect exhaustion — the user can't
    // recover without reloading. Per-turn failures are now authoritative
    // `liveness: failed` verdicts rendered as a retryable bubble in the thread,
    // not a client-side "agent did not respond" guess.
    const lastError = bundle.reconnectExhausted
      ? "Connection lost. Reload the page to resume."
      : null;
    store.getState().publish(chatSessionKey(agentId, chatId), {
      agentId,
      chatId,
      runtime: bundle.runtime,
      isRunning: bundle.isRunning,
      isConnected: bundle.isConnected,
      isHistoryLoaded: bundle.isHistoryLoaded,
      isReconcilingMessages: bundle.isReconcilingMessages,
      hasInitialContent: bundle.hasInitialContent,
      isOpenClawConnected: bundle.isOpenClawConnected,
      isDelayed: bundle.isDelayed,
      reconnectExhausted: bundle.reconnectExhausted,
      payloadRejected: bundle.payloadRejected,
      hasInlineError: bundle.hasInlineError,
      onRetryContinue,
      onRetryResend,
      lastError,
      pendingUploads: bundle.pendingUploads,
      addPendingUpload,
      removePendingUpload,
      retryPendingUpload,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agentId,
    chatId,
    store,
    bundle.runtime,
    bundle.isRunning,
    bundle.isConnected,
    bundle.isHistoryLoaded,
    bundle.isReconcilingMessages,
    bundle.hasInitialContent,
    bundle.isOpenClawConnected,
    bundle.isDelayed,
    bundle.reconnectExhausted,
    bundle.payloadRejected,
    bundle.hasInlineError,
    bundle.pendingUploads,
  ]);

  return null;
}
