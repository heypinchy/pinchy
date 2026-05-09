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
import {
  CLIENT_IMAGE_COMPRESSION_TARGET_BYTES,
  CLIENT_MAX_ATTACHMENT_SIZE_BYTES,
} from "@/lib/limits";
import { compressImageForChat } from "@/lib/image-compression";
import { dataUrlToFile, fileToDataUrl } from "@/lib/data-url";

export interface WsMessage {
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
  retryReason?: "orphan" | "partial_stream_failure" | "send_failure";
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

type WsContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

/**
 * Build the WebSocket content payload — plain string when there are no images,
 * structured parts array when images need to be carried alongside text.
 */
function buildWsContent(text: string, images: string[] | undefined): WsContent {
  if (!images || images.length === 0) {
    return text;
  }
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img } });
  }
  return parts;
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
  /**
   * Upstream OpenClaw connectivity. Independent from `isConnected` (which only
   * tracks the browser↔Pinchy WS). Defaults to false — green must be earned
   * via an `openclaw_status: true` frame from the server. Defaulting to true
   * caused issue #198 (indicator lied during the OpenClaw cold-start window
   * after a fresh deploy, when the server has no chance to push a status
   * frame because the broadcaster wasn't initialised yet).
   */
  isOpenClawConnected: boolean;
  /**
   * True once the chat has something renderable on screen — at least one
   * message OR an authoritative "session known but empty" signal from the
   * server. Drives the transition out of "starting" so the indicator can't
   * turn green before the initial greeting/history is committed (issue #197).
   */
  hasInitialContent: boolean;
  reconnectExhausted: boolean;
  isOrphaned: boolean;
  onRetryContinue: (reason: "orphan" | "partial_stream_failure" | "send_failure") => void;
  onRetryResend: (messageId: string) => void;
} {
  const { triggerRestart } = useRestart();
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isDelayed, setIsDelayed] = useState(false);
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  /**
   * Set when the server confirms a session exists but its history is
   * temporarily unavailable (e.g. during an OpenClaw restart). Lets the chat
   * leave "starting" with an empty thread instead of waiting forever for
   * messages that won't arrive. Reset on every reconnect/agent-switch.
   */
  const [knownEmptyHistory, setKnownEmptyHistory] = useState(false);
  const [isOpenClawConnected, setIsOpenClawConnected] = useState(false);
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
  /**
   * True iff at least one assistant chunk was received during the current turn.
   * Reset when a new turn starts (user sends or retry). Used to classify
   * incoming error frames: with chunks → partial_stream_failure, without
   * chunks → send_failure. Both reasons resend the original user message.
   */
  const hasReceivedChunkRef = useRef(false);
  /**
   * Set when a retry is triggered; cleared on the first chunk of the new turn.
   * Tells the chunk handler to drop any trailing partial assistant response
   * (left over from the interrupted previous turn) so the UI shows only the
   * fresh response, matching what survives in OpenClaw's persisted history.
   */
  const trimTrailingOnNextChunkRef = useRef(false);
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
    setKnownEmptyHistory(false);
  }

  const dispatchMessages = useCallback((action: Action) => {
    setMessages((prev) => reduceMessages(prev, action));
  }, []);

  useEffect(() => {
    // Update before connect() so stale handlers from the previous agent see
    // the new agentId as soon as the cleanup's ws.close() fires asynchronously.
    agentIdRef.current = agentId;
    mountedRef.current = true;
    reconnectAttemptRef.current = 0;
    shouldRecoverFromHistoryRef.current = false;

    // Snapshot the ack-timers Map at effect start so the cleanup can iterate
    // it without ESLint flagging "ref value will likely have changed". The
    // ref's `.current` is never reassigned (only mutated via set/delete), so
    // `ackTimers` and `pendingAckTimers.current` always point to the same Map.
    const ackTimers = pendingAckTimers.current;

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

      ws.onclose = (event?: CloseEvent) => {
        if (connectionAgentId !== agentIdRef.current) return;
        setIsConnected(false);
        setIsDelayed(false);
        clearStuckTimer();
        if (delayTimerRef.current) {
          clearTimeout(delayTimerRef.current);
          delayTimerRef.current = null;
        }

        // Close-code 1009: the incoming frame exceeded maxPayload. The frame
        // has already been dropped — retrying the same oversized frame would
        // hit the same limit, so this is NOT retryable.
        if (event?.code === 1009) {
          // Cancel any pending ack timers — the oversized frame was dropped, so
          // the ack will never arrive. Without this, the 10s timer fires after
          // the 1009 error bubble is already shown, producing a second error
          // signal for the same event.
          for (const timer of pendingAckTimers.current.values()) {
            clearTimeout(timer);
          }
          pendingAckTimers.current.clear();
          isRunningRef.current = false;
          setIsRunning(false);
          setIsHistoryLoaded(false);
          setKnownEmptyHistory(false);
          setMessages((prev) => [
            ...prev,
            {
              id: uuid(),
              role: "assistant",
              content: "",
              error: {
                payloadTooLarge: true,
                message: `File too large to send. Please use a file smaller than ${Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024)} MB.`,
              },
              // retryable intentionally absent — absence means false per codebase convention
            },
          ]);
          return;
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
              retryReason: hasReceivedChunkRef.current
                ? ("partial_stream_failure" as const)
                : ("send_failure" as const),
            },
          ]);
        } else {
          setIsRunning(false);
        }

        setIsHistoryLoaded(false);
        setKnownEmptyHistory(false);

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

          if (data.type === "openclaw_status") {
            setIsOpenClawConnected(!!data.connected);
            return;
          }

          if (data.type === "history") {
            const serverMessages: Array<{ role: string; content: string; timestamp?: string }> =
              data.messages ?? [];
            const sessionKnown: boolean = data.sessionKnown === true;
            // Server tells us the session exists but its history is currently
            // unavailable (e.g. OpenClaw restart race). Without this flag the
            // chat would sit in "starting" forever waiting for messages that
            // aren't coming — see issue #197.
            setKnownEmptyHistory(sessionKnown && serverMessages.length === 0);
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
              // After reconnects, replace local messages with canonical history
              // from the server. Skip the wipe when server history is empty
              // (typically because upstream OpenClaw is unreachable and Pinchy
              // returned an empty history) — empty can't be canonical when we
              // already have local messages.
              // Note: we intentionally replace even if the last local message is
              // a synthetic disconnect-error bubble, because the server's history
              // is the ground truth after reconnect.
              if (shouldRecoverFromHistory && historyMessages.length > 0) {
                // Only replace if the last non-error message is an assistant turn
                // (i.e. we were in the middle of a response when disconnected).
                const lastNonError = [...prev].reverse().find((m) => !m.error);
                if (lastNonError?.role === "assistant") {
                  return historyMessages;
                }
              }
              return prev;
            });
            shouldRecoverFromHistoryRef.current = false;
            // Reconcile any in-flight "sending" messages against server history.
            // Route through the reducer so matching logic is centralised.
            dispatchMessages({
              type: "history-reconcile",
              history: serverMessages.map((m) => ({ role: m.role, content: m.content })),
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
            // Also cancel any pending ack timers — OpenClaw is clearly processing
            // this session so the message was received.
            for (const timer of pendingAckTimers.current.values()) {
              clearTimeout(timer);
            }
            pendingAckTimers.current.clear();
            isRunningRef.current = true;
            setIsRunning(true);
            resetStuckTimer();
            return;
          }

          if (data.type === "chunk") {
            // Cancel pending ack timers — receiving a chunk proves OpenClaw got the
            // message, so the ack timeout would be a false positive if it fired now.
            for (const timer of pendingAckTimers.current.values()) {
              clearTimeout(timer);
            }
            pendingAckTimers.current.clear();
            isRunningRef.current = true;
            hasReceivedChunkRef.current = true;
            setIsRunning(true);
            resetStuckTimer();

            if (delayTimerRef.current) {
              clearTimeout(delayTimerRef.current);
              delayTimerRef.current = null;
            }
            setIsDelayed(false);

            setMessages((prev) => {
              // A successful chunk auto-dismisses any prior error bubble — the
              // retry succeeded, so the previous failure no longer reflects state.
              let filtered = prev.filter((m) => !m.error);
              // Right after a retry, drop any trailing partial assistant from the
              // interrupted previous turn so the UI matches what OpenClaw actually
              // persisted. Only fires on the first chunk of the new turn.
              if (trimTrailingOnNextChunkRef.current) {
                trimTrailingOnNextChunkRef.current = false;
                const lastUserIdx = filtered.map((m) => m.role).lastIndexOf("user");
                if (lastUserIdx >= 0) {
                  filtered = filtered.slice(0, lastUserIdx + 1);
                }
              }
              const last = filtered[filtered.length - 1];
              if (last?.role === "assistant" && last.id === data.messageId) {
                return [
                  ...filtered.slice(0, -1),
                  { ...last, content: last.content + data.content },
                ];
              }
              return [
                ...filtered,
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
            hasReceivedChunkRef.current = false;
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
                  modelUnavailable: data.modelUnavailable,
                }
              : { message: data.message || "An unknown error occurred." };

            setMessages((prev) => [
              // Remove any existing error bubble — only one error is ever shown
              // at a time to avoid stacking after repeated retries.
              ...prev.filter((m) => !m.error),
              {
                id: uuid(),
                role: "assistant",
                content: "",
                error,
                retryable: true,
                retryReason: hasReceivedChunkRef.current
                  ? ("partial_stream_failure" as const)
                  : ("send_failure" as const),
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
      // Clear all pending ack timers to avoid memory leaks and stale dispatches.
      // Use the snapshot captured at effect start (see comment above) — the ref
      // is never reassigned, so the snapshot points to the same Map.
      for (const timer of ackTimers.values()) {
        clearTimeout(timer);
      }
      ackTimers.clear();
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Auto-recovery: when OpenClaw becomes reachable again after being unavailable,
  // re-request history so the session is populated with any messages that arrived
  // while we were offline (e.g. OpenClaw cold-cache scenario from Task 1).
  // Only fires on the rising edge (false → true) and only after history has already
  // been loaded once — this prevents double-requesting on the initial connect where
  // ws.onopen already sends the history frame.
  const fullyConnected = isConnected && isOpenClawConnected;
  const prevFullyConnectedRef = useRef(fullyConnected);
  useEffect(() => {
    const wasConnected = prevFullyConnectedRef.current;
    prevFullyConnectedRef.current = fullyConnected;
    // Skip the initial render (no transition yet)
    if (wasConnected === fullyConnected) return;
    // Rising edge: was disconnected/unavailable, is now fully connected
    if (fullyConnected && !wasConnected && isHistoryLoaded) {
      wsRef.current?.send(JSON.stringify({ type: "history", agentId }));
    }
  }, [fullyConnected, isHistoryLoaded, agentId]);

  /**
   * Send a JSON-serialised payload over the WebSocket if it's open, otherwise
   * queue it for delivery the moment the next connection completes the
   * handshake (see `connect()` in the main effect — it flushes
   * pendingMessageRef on open).
   */
  const sendOrQueue = useCallback((payload: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(payload);
    } else {
      pendingMessageRef.current = payload;
    }
  }, []);

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

      // Compress client-side to WebP < 1.9 MB before sending.
      // OpenClaw's agent.run path offloads images > 2 MB as text-only markers.
      const compressedImages: string[] = [];
      for (const img of images) {
        const file = dataUrlToFile(img);
        const result = await compressImageForChat(file);

        // Fail closed when compression failed AND the original would be silently
        // offloaded by OpenClaw (size > inline threshold). Sending a "ghost" image
        // the model can't see is worse than refusing to send.
        if (!result.ok && result.file.size > CLIENT_IMAGE_COMPRESSION_TARGET_BYTES) {
          setMessages((prev) => [
            ...prev,
            {
              id: uuid(),
              role: "assistant",
              content:
                "Couldn't process this image format. Please convert it to JPEG, PNG, or WebP and try again.",
            },
          ]);
          return;
        }

        // Check size AFTER compression — reject if still too large for the WS frame.
        // Checking file.size (bytes) avoids materialising the full data URL string
        // just to count characters.
        if (result.file.size > CLIENT_MAX_ATTACHMENT_SIZE_BYTES) {
          setMessages((prev) => [
            ...prev,
            {
              id: uuid(),
              role: "assistant",
              content: `File exceeds the ${Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024)} MB size limit. Please use a smaller file.`,
            },
          ]);
          return;
        }

        compressedImages.push(await fileToDataUrl(result.file));
      }

      if (!text.trim() && compressedImages.length === 0) return;

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
          ...(compressedImages.length > 0 && { images: compressedImages }),
        },
      ]);

      isRunningRef.current = true;
      hasReceivedChunkRef.current = false;
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

      const payload = JSON.stringify({
        type: "message",
        content: buildWsContent(text, compressedImages),
        agentId,
        clientMessageId,
      });

      sendOrQueue(payload);

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
    [agentId, dispatchMessages, sendOrQueue]
  );

  const onRetryContinue = useCallback(
    (reason: "orphan" | "partial_stream_failure" | "send_failure") => {
      // All retry reasons go through the resend path — the OpenClaw Gateway
      // requires `message: NonEmptyString` on every agent request, so there's
      // no "continue from session history without a new message" mode. The
      // reason is threaded through the message frame so the audit log
      // distinguishes orphan / partial_stream_failure / send_failure retries.
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg) return;

      if (lastUserMsg.status === "failed") {
        dispatchMessages({ type: "retry-resend", clientMessageId: lastUserMsg.id });
      }

      isRunningRef.current = true;
      hasReceivedChunkRef.current = false;
      trimTrailingOnNextChunkRef.current = true;
      setIsRunning(true);

      const payload = JSON.stringify({
        type: "message",
        agentId,
        content: buildWsContent(lastUserMsg.content, lastUserMsg.images),
        clientMessageId: lastUserMsg.id,
        isRetry: true,
        retryReason: reason,
      });

      sendOrQueue(payload);
    },
    [agentId, messages, dispatchMessages, sendOrQueue]
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

      // Re-send the WS frame with the SAME clientMessageId and original content
      const payload = JSON.stringify({
        type: "message",
        agentId,
        content: buildWsContent(failedMsg.content, failedMsg.images),
        clientMessageId: messageId,
        isRetry: true,
      });

      sendOrQueue(payload);

      // Restart the 10s ack timer
      const ackTimer = setTimeout(() => {
        pendingAckTimers.current.delete(messageId);
        dispatchMessages({ type: "timeout", clientMessageId: messageId });
      }, 10_000);
      pendingAckTimers.current.set(messageId, ackTimer);
    },
    [agentId, messages, dispatchMessages, sendOrQueue]
  );

  const isOrphaned = computeIsOrphaned(messages, { isRunning, isHistoryLoaded });
  const hasInitialContent = messages.length > 0 || knownEmptyHistory;

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
    hasInitialContent,
    isOpenClawConnected,
    reconnectExhausted,
    isOrphaned,
    onRetryContinue,
    onRetryResend,
  };
}
