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
  isConnected: boolean;
  isDelayed: boolean;
  isHistoryLoaded: boolean;
  reconnectExhausted: boolean;
  isOrphaned: boolean;
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
            const serverMessages: Array<{ role: string; content: string; timestamp?: string }> =
              data.messages ?? [];
            const historyMessages = serverMessages.map((msg) => ({
              id: uuid(),
              role: msg.role === "system" ? "assistant" : msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
            }));
            // Build a set of user message content strings from the server history.
            // Used below to reconcile in-flight "sending" messages by content match.
            const historyUserContents = new Set(
              serverMessages.filter((msg) => msg.role === "user").map((msg) => msg.content)
            );
            const shouldRecoverFromHistory = shouldRecoverFromHistoryRef.current;
            setMessages((prev) => {
              let next: WsMessage[];
              if (prev.length === 0) {
                next = historyMessages;
              } else {
                // After reconnects, replace a partial trailing assistant message
                // with canonical history from the server.
                const last = prev[prev.length - 1];
                if (shouldRecoverFromHistory && last?.role === "assistant") {
                  next = historyMessages;
                } else {
                  next = prev;
                }
              }

              // Reconcile any in-flight "sending" messages against server history.
              // If a sending message's content appears in the history, it was
              // persisted → upgrade to "sent". Otherwise it was lost → mark "failed".
              return next.map((msg) => {
                if (msg.status !== "sending") return msg;
                return {
                  ...msg,
                  status: historyUserContents.has(msg.content) ? "sent" : "failed",
                };
              });
            });
            shouldRecoverFromHistoryRef.current = false;
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
            isRunningRef.current = true;
            setIsRunning(true);
            resetStuckTimer();
            return;
          }

          if (data.type === "chunk") {
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
      const ackTimer = setTimeout(() => {
        pendingAckTimers.current.delete(clientMessageId);
        dispatchMessages({ type: "timeout", clientMessageId });
      }, 10_000);
      pendingAckTimers.current.set(clientMessageId, ackTimer);
    },
    [agentId, dispatchMessages]
  );

  const convertedMessages = useMemo(() => messages.map(convertMessage), [messages]);

  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    isRunning,
    convertMessage: (msg: ThreadMessageLike) => msg,
    onNew,
    adapters: {
      attachments: attachmentAdapter,
    },
  });

  const isOrphaned = computeIsOrphaned(messages, { isRunning, isHistoryLoaded });

  return { runtime, isConnected, isDelayed, isHistoryLoaded, reconnectExhausted, isOrphaned };
}
