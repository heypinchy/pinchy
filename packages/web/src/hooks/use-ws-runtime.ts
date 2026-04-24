"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRestart } from "@/components/restart-provider";
import { uuid } from "@/lib/uuid";
import {
  useExternalStoreRuntime,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  CompositeAttachmentAdapter,
  type ThreadMessageLike,
  type AppendMessage,
  type AssistantRuntime,
} from "@assistant-ui/react";
import type { ChatError } from "@/components/assistant-ui/chat-error-message";
import { reduceMessages, type Action } from "./message-status-reducer";
import type { MessageStatus } from "./message-status-reducer";
import { isOrphaned as computeIsOrphaned } from "./orphan-detector";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

interface WsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  timestamp?: string;
  error?: ChatError;
  /** Delivery status — only set for user messages managed by the reducer */
  status?: MessageStatus;
  /** When true, the UI shows a Retry button to re-trigger the agent */
  retryable?: boolean;
  /** Which retry action to invoke — only set when retryable is true */
  retryReason?: "orphan" | "partial_stream_failure";
}

const DELAY_HINT_MS = 15_000;
const STUCK_TIMEOUT_MS = 60_000;

function convertMessage(msg: WsMessage): ThreadMessageLike {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
    { type: "text", text: msg.content },
  ];

  if (msg.images) {
    for (const image of msg.images) {
      parts.push({ type: "image", image });
    }
  }

  const custom: Record<string, unknown> = {};
  if (msg.timestamp) custom.timestamp = msg.timestamp;
  if (msg.error) custom.error = msg.error;
  if (msg.status) custom.status = msg.status;
  if (msg.retryable) custom.retryable = msg.retryable;
  if (msg.retryReason) custom.retryReason = msg.retryReason;

  return {
    role: msg.role,
    content: parts,
    id: msg.id,
    metadata: Object.keys(custom).length > 0 ? { custom } : undefined,
  };
}

class CodeTextAttachmentAdapter extends SimpleTextAttachmentAdapter {
  public override accept =
    "text/plain,text/html,text/markdown,text/csv,text/xml,text/json,text/css,application/javascript,application/typescript,.js,.ts,.tsx,.jsx,.py,.rs,.go,.sh,.sql,.yaml,.yml,.toml,.json";
}

const attachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
  new CodeTextAttachmentAdapter(),
]);

const MAX_RECONNECT_ATTEMPTS = 10;

export function useWsRuntime(agentId: string): {
  runtime: AssistantRuntime;
  isRunning: boolean;
  isConnected: boolean;
  isDelayed: boolean;
  isHistoryLoaded: boolean;
  reconnectExhausted: boolean;
  isOrphaned: boolean;
  onRetryContinue: (reason: "orphan" | "partial_stream_failure") => void;
  onRetryResend: (messageId: string) => void;
} {
  const { triggerRestart } = useRestart();
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isDelayed, setIsDelayed] = useState(false);
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetStuckTimerRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRecoverFromHistoryRef = useRef(false);
  const pendingMessageRef = useRef<string | null>(null);
  const isRunningRef = useRef(false);
  /** Tracks pending ack timers by clientMessageId. Cleared on ack or unmount. */
  const pendingAckTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Tracks the current agentId so stale WebSocket handlers (from before an
  // agent switch) can detect they belong to an old connection and bail out.
  // Updated at the start of the useEffect (before connecting), not during render,
  // so the new value is in place before any stale onclose/onmessage fires.
  const agentIdRef = useRef(agentId);

  // Reset state when switching agents — prevents stale messages from
  // one agent blocking history load for a different agent.
  // Uses "adjust state during render" pattern (React-recommended over useEffect).
  const [prevAgentId, setPrevAgentId] = useState(agentId);
  if (prevAgentId !== agentId) {
    setPrevAgentId(agentId);
    setMessages([]);
    setIsRunning(false);
    setIsDelayed(false);
    setIsHistoryLoaded(false);
  }

  /**
   * Dispatch a reducer action against the messages state.
   * The hook's WsMessage is a superset of the reducer's WsMessage shape —
   * we cast here so the pure reducer can operate on the shared `id` and
   * `status` fields without needing to know about `images`, `error`, etc.
   */
  const dispatchMessages = useCallback((action: Action) => {
    setMessages(
      (prev) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reduceMessages(prev as any, action) as unknown as WsMessage[]
    );
  }, []);

  useEffect(() => {
    // Update before connect() so stale handlers from the previous agent see
    // the new agentId as soon as the cleanup's ws.close() fires asynchronously.
    agentIdRef.current = agentId;
    mountedRef.current = true;
    reconnectAttemptRef.current = 0;
    shouldRecoverFromHistoryRef.current = false;

    function clearStuckTimer() {
      if (stuckTimerRef.current) {
        clearTimeout(stuckTimerRef.current);
        stuckTimerRef.current = null;
      }
    }

    function resetStuckTimer() {
      clearStuckTimer();
      stuckTimerRef.current = setTimeout(() => {
        isRunningRef.current = false;
        setIsRunning(false);
        setIsDelayed(false);
        setMessages((prev) => [
          ...prev,
          {
            id: uuid(),
            role: "assistant",
            content: "",
            error: { timedOut: true },
            retryable: true,
            retryReason: "partial_stream_failure" as const,
          },
        ]);
      }, STUCK_TIMEOUT_MS);
    }

    // Expose resetStuckTimer to onNew (defined outside this useEffect)
    resetStuckTimerRef.current = resetStuckTimer;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws?agentId=${agentId}`);
      // Snapshot the agentId at connection time. Handlers compare this against
      // agentIdRef.current to detect stale connections after an agent switch.
      const connectionAgentId = agentId;

      ws.onopen = () => {
        setIsConnected(true);
        setReconnectExhausted(false);
        reconnectAttemptRef.current = 0;
        ws.send(JSON.stringify({ type: "history", agentId }));

        // Flush any message that was queued while disconnected/connecting
        if (pendingMessageRef.current) {
          ws.send(pendingMessageRef.current);
          pendingMessageRef.current = null;
        }
      };

      ws.onclose = () => {
        if (connectionAgentId !== agentIdRef.current) return;
        setIsConnected(false);
        setIsDelayed(false);
        clearStuckTimer();
        if (delayTimerRef.current) {
          clearTimeout(delayTimerRef.current);
          delayTimerRef.current = null;
        }

        // If a stream was in progress, inject a disconnect error so the user
        // knows the response may have been lost.
        if (isRunningRef.current) {
          isRunningRef.current = false;
          setIsRunning(false);
          setMessages((prev) => [
            ...prev,
            {
              id: uuid(),
              role: "assistant",
              content: "",
              error: { disconnected: true },
              retryable: true,
              retryReason: "partial_stream_failure" as const,
            },
          ]);
        } else {
          setIsRunning(false);
        }

        setIsHistoryLoaded(false);

        if (mountedRef.current && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
          shouldRecoverFromHistoryRef.current = true;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 5000);
          reconnectAttemptRef.current++;
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else if (mountedRef.current) {
          setReconnectExhausted(true);
        }
      };

      ws.onerror = () => {
        if (connectionAgentId !== agentIdRef.current) return;
        // onclose always fires after onerror — let onclose handle isRunning and
        // the disconnect error injection so the user sees the right feedback.
        setIsConnected(false);
        clearStuckTimer();
      };

      ws.onmessage = (event) => {
        if (connectionAgentId !== agentIdRef.current) return;
        try {
          const data = JSON.parse(event.data);

          if (data.type === "openclaw:restarting") {
            triggerRestart();
            return;
          }

          if (data.type === "history") {
            const serverMessages: Array<{
              role: string;
              content: string;
              timestamp?: string;
              clientMessageId?: string;
            }> = data.messages ?? [];
            const historyMessages: WsMessage[] = serverMessages.map((msg) => ({
              id: uuid(),
              role: (msg.role === "system" ? "assistant" : msg.role) as "user" | "assistant",
              content: msg.content ?? "",
              timestamp: msg.timestamp,
            }));
            const shouldRecoverFromHistory = shouldRecoverFromHistoryRef.current;
            setMessages((prev) => {
              if (prev.length === 0) {
                return historyMessages;
              }
              // After reconnects, replace a partial trailing assistant message
              // with canonical history from the server.
              const last = prev[prev.length - 1];
              if (shouldRecoverFromHistory && last?.role === "assistant") {
                return historyMessages;
              }
              return prev;
            });
            shouldRecoverFromHistoryRef.current = false;
            // Reconcile any in-flight "sending" messages against server history.
            // Forward clientMessageId through so the reducer can match by id —
            // required to distinguish duplicate-content messages correctly.
            dispatchMessages({
              type: "history-reconcile",
              history: serverMessages.map((m) => ({
                role: m.role,
                content: m.content,
                clientMessageId: m.clientMessageId,
              })),
            });
            setIsHistoryLoaded(true);
            return;
          }

          if (data.type === "ack") {
            // Cancel the pending timeout timer before dispatching the ack
            const clientMessageId = data.clientMessageId as string;
            const ackTimer = pendingAckTimers.current.get(clientMessageId);
            if (ackTimer !== undefined) {
              clearTimeout(ackTimer);
              pendingAckTimers.current.delete(clientMessageId);
            }
            // Transition user message sending → sent
            dispatchMessages({ type: "ack", clientMessageId });
            return;
          }

          if (data.type === "thinking") {
            // Server keep-alive: defeats browser/proxy WebSocket idle
            // timeouts during long pauses (e.g. local Ollama tool-use loops).
            // Reset stuck timer so a slow-but-alive agent doesn't get killed.
            // Also cancel any pending ack timers and flip the underlying user
            // messages sending → sent: a heartbeat proves OpenClaw has the
            // session and is working, so delivery is confirmed even if the
            // dedicated userMessagePersisted event never arrived.
            for (const [clientMessageId, timer] of pendingAckTimers.current.entries()) {
              clearTimeout(timer);
              dispatchMessages({ type: "ack", clientMessageId });
            }
            pendingAckTimers.current.clear();
            isRunningRef.current = true;
            setIsRunning(true);
            resetStuckTimer();
            return;
          }

          if (data.type === "chunk") {
            // Cancel pending ack timers and confirm delivery — receiving a
            // chunk proves OpenClaw got the message, so any still-"sending"
            // user message must transition to "sent" (even if the explicit
            // userMessagePersisted event raced with or preceded the first
            // chunk). Without this fallback the user bubble would stay
            // dimmed (opacity-60) for the full agent turn.
            for (const [clientMessageId, timer] of pendingAckTimers.current.entries()) {
              clearTimeout(timer);
              dispatchMessages({ type: "ack", clientMessageId });
            }
            pendingAckTimers.current.clear();
            isRunningRef.current = true;
            setIsRunning(true);
            resetStuckTimer();

            if (delayTimerRef.current) {
              clearTimeout(delayTimerRef.current);
              delayTimerRef.current = null;
            }
            setIsDelayed(false);

            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.id === data.messageId) {
                return [...prev.slice(0, -1), { ...last, content: last.content + data.content }];
              }
              return [
                ...prev,
                {
                  id: data.messageId,
                  role: "assistant",
                  content: data.content,
                  timestamp: new Date().toISOString(),
                },
              ];
            });
          }

          if (data.type === "done") {
            // Per-turn done: only marks the end of one assistant turn.
            // The spinner is NOT cleared here — only "complete" terminates
            // the entire stream. Tool-use loops produce one "done" per turn.
            // Intentionally a no-op for isRunning.
          }

          if (data.type === "complete") {
            if (delayTimerRef.current) {
              clearTimeout(delayTimerRef.current);
              delayTimerRef.current = null;
            }
            clearStuckTimer();
            setIsDelayed(false);
            isRunningRef.current = false;
            setIsRunning(false);
          }

          if (data.type === "error") {
            if (delayTimerRef.current) {
              clearTimeout(delayTimerRef.current);
              delayTimerRef.current = null;
            }
            clearStuckTimer();
            setIsDelayed(false);

            const error: ChatError = data.providerError
              ? {
                  agentName: data.agentName,
                  providerError: data.providerError,
                  hint: data.hint,
                }
              : { message: data.message || "An unknown error occurred." };

            setMessages((prev) => [
              ...prev,
              {
                id: uuid(),
                role: "assistant",
                content: "",
                error,
                retryable: true,
                retryReason: "partial_stream_failure" as const,
              },
            ]);
            isRunningRef.current = false;
            setIsRunning(false);
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
      }
      clearStuckTimer();
      // Clear all pending ack timers to avoid memory leaks and stale dispatches
      for (const timer of pendingAckTimers.current.values()) {
        clearTimeout(timer);
      }
      pendingAckTimers.current.clear();
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const textParts = message.content.filter((part) => part.type === "text");
      const text = textParts.map((part) => ("text" in part ? part.text : "")).join("");

      // Extract images from attachments (assistant-ui puts them there, not in content)
      const attachments =
        (
          message as {
            attachments?: Array<{
              type: string;
              content?: Array<{ type: string; image?: string }>;
            }>;
          }
        ).attachments ?? [];
      const images: string[] = [];
      for (const att of attachments) {
        if (att.type === "image" && att.content) {
          for (const c of att.content) {
            if (c.type === "image" && c.image) {
              images.push(c.image);
            }
          }
        }
      }

      // Check image size limit
      for (const img of images) {
        if (img.length > MAX_IMAGE_SIZE) {
          setMessages((prev) => [
            ...prev,
            {
              id: uuid(),
              role: "assistant",
              content: "Image exceeds the 5MB size limit. Please use a smaller image.",
            },
          ]);
          return;
        }
      }

      if (!text.trim() && images.length === 0) return;

      const clientMessageId = uuid();

      // Add the user message directly with status: "sending" and an ISO timestamp
      // for display. The reducer is used only for status transitions (ack, timeout,
      // etc.) on already-added messages — not for the initial insertion, so we keep
      // the hook's string timestamp format intact.
      setMessages((prev) => [
        ...prev,
        {
          id: clientMessageId,
          role: "user",
          content: text,
          timestamp: new Date().toISOString(),
          status: "sending",
          ...(images.length > 0 && { images }),
        },
      ]);

      isRunningRef.current = true;
      setIsRunning(true);

      // Start delay hint timer
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
      }
      delayTimerRef.current = setTimeout(() => {
        setIsDelayed(true);
      }, DELAY_HINT_MS);

      // Start stuck timer — fires if no activity (chunk or thinking) for 60s
      resetStuckTimerRef.current?.();

      // Build content: structured array if images present, plain string otherwise
      let wsContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
      if (images.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        if (text) {
          parts.push({ type: "text", text });
        }
        for (const img of images) {
          parts.push({ type: "image_url", image_url: { url: img } });
        }
        wsContent = parts;
      } else {
        wsContent = text;
      }

      const payload = JSON.stringify({
        type: "message",
        content: wsContent,
        agentId,
        clientMessageId,
      });

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(payload);
      } else {
        // Queue for delivery when connection opens
        pendingMessageRef.current = payload;
      }

      // Start a 10-second ack timeout. If no ack arrives before the timer
      // fires, dispatch a "timeout" action to transition the message to "failed".
      // Note: isRunning is NOT reset here — the ack timeout only covers message
      // delivery status. isRunning resets only on complete/error/disconnect/stuck.
      const ackTimer = setTimeout(() => {
        pendingAckTimers.current.delete(clientMessageId);
        dispatchMessages({ type: "timeout", clientMessageId });
      }, 10_000);
      pendingAckTimers.current.set(clientMessageId, ackTimer);
    },
    [agentId, dispatchMessages]
  );

  const onRetryContinue = useCallback(
    (reason: "orphan" | "partial_stream_failure") => {
      isRunningRef.current = true;
      setIsRunning(true);

      const payload = JSON.stringify({ type: "retry-continue", agentId, reason });

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(payload);
      } else {
        // Queue for delivery when connection opens
        pendingMessageRef.current = payload;
      }
    },
    [agentId]
  );

  const onRetryResend = useCallback(
    (messageId: string) => {
      // Find the failed message — bail out if not found or not in failed state
      const failedMsg = messages.find((m) => m.id === messageId && m.status === "failed");
      if (!failedMsg) return;

      // Flip status back to "sending"
      dispatchMessages({ type: "retry-resend", clientMessageId: messageId });

      isRunningRef.current = true;
      setIsRunning(true);

      // Start delay hint timer
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
      }
      delayTimerRef.current = setTimeout(() => {
        setIsDelayed(true);
      }, DELAY_HINT_MS);

      // Start stuck timer — fires if no activity (chunk or thinking) for 60s
      resetStuckTimerRef.current?.();

      // Build content: structured array if images present, plain string otherwise
      let wsContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
      if (failedMsg.images && failedMsg.images.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        if (failedMsg.content) {
          parts.push({ type: "text", text: failedMsg.content });
        }
        for (const img of failedMsg.images) {
          parts.push({ type: "image_url", image_url: { url: img } });
        }
        wsContent = parts;
      } else {
        wsContent = failedMsg.content;
      }

      // Re-send the WS frame with the SAME clientMessageId and original content
      const payload = JSON.stringify({
        type: "message",
        agentId,
        content: wsContent,
        clientMessageId: messageId,
        isRetry: true,
      });

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(payload);
      } else {
        pendingMessageRef.current = payload;
      }

      // Restart the 10s ack timer
      const ackTimer = setTimeout(() => {
        pendingAckTimers.current.delete(messageId);
        dispatchMessages({ type: "timeout", clientMessageId: messageId });
      }, 10_000);
      pendingAckTimers.current.set(messageId, ackTimer);
    },
    [agentId, messages, dispatchMessages]
  );

  const isOrphaned = computeIsOrphaned(messages, { isRunning, isHistoryLoaded });

  const convertedMessages = useMemo(() => {
    const base = messages.map(convertMessage);
    if (isOrphaned) {
      return [
        ...base,
        {
          role: "assistant" as const,
          id: "synthetic-orphan",
          content: [{ type: "text" as const, text: "The agent didn't respond." }],
          metadata: {
            custom: { syntheticOrphanError: true, retryable: true, retryReason: "orphan" },
          },
        },
      ];
    }
    return base;
  }, [messages, isOrphaned]);

  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    isRunning,
    convertMessage: (msg: ThreadMessageLike) => msg,
    onNew,
    adapters: {
      attachments: attachmentAdapter,
    },
  });

  return {
    runtime,
    isRunning,
    isConnected,
    isDelayed,
    isHistoryLoaded,
    reconnectExhausted,
    isOrphaned,
    onRetryContinue,
    onRetryResend,
  };
}
