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

/** Lightweight metadata for binary file attachments shown next to user messages. */
export interface WsFileMeta {
  filename: string;
  mimeType: string;
}

export interface WsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  /**
   * Non-image attachments shown as chips next to the user message. Only the
   * filename + mimeType are kept here — the actual bytes already live in the
   * agent's workspace and don't need to be replayed in client memory.
   */
  files?: WsFileMeta[];
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

/**
 * Append the canonical "payload too large" error bubble to the message list.
 *
 * Three independent code paths can reject an oversize attachment:
 *   1. `SimpleBinaryFileAttachmentAdapter.add()` — pre-encode, throws to the
 *      composer (handled outside this hook).
 *   2. `onNew` binary-file size check — after the adapter has produced
 *      content but before the WS payload is built.
 *   3. `onNew` image size check — after client-side compression couldn't get
 *      the file under the limit.
 *   4. WS close-code 1009 ("Message too big") — the server rejected the
 *      frame at the transport layer.
 *
 * All UI-visible rejections share the same shape so the inline error
 * renderer in `ChatErrorMessage` always picks up the correct icon, heading
 * ("File too large"), and styling. The plain-content fallback that used to
 * live on the image path was visually inconsistent and is gone.
 */
export function buildAttachmentTooLargeError(): ChatError {
  const limitMb = Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024);
  return {
    payloadTooLarge: true,
    message: `File exceeds the ${limitMb} MB size limit. Please use a smaller file.`,
  };
}

function convertMessage(msg: WsMessage): ThreadMessageLike {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image"; image: string }
    | { type: "file"; data: string; mimeType: string; filename: string }
  > = [{ type: "text", text: msg.content }];

  if (msg.images) {
    for (const image of msg.images) {
      parts.push({ type: "image", image });
    }
  }

  if (msg.files) {
    for (const file of msg.files) {
      // `data` is required by the assistant-ui FileMessagePart shape but the
      // FilePart renderer only reads `mimeType` + `filename`. Pass an empty
      // string — the actual bytes live in the agent's workspace, not in
      // client memory.
      parts.push({ type: "file", data: "", mimeType: file.mimeType, filename: file.filename });
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

/**
 * Adapter for binary files the model can read.
 *
 * Currently: PDF only. Audio is tracked in #321 — it requires a transcription
 * pipeline that does not yet exist; accepting audio here without it would
 * persist files the agent has no way to read.
 *
 * Lifecycle:
 *   add()  — validates size up front, then returns a PendingAttachment.
 *            File reading (base64 encode) is deferred to send() so picking
 *            the file is cheap.
 *   send() — reads the file, extracts base64 data + mimeType, returns a
 *            CompleteAttachment with a FileMessagePart in content.
 *   remove() — no-op (local files need no cleanup).
 *
 * onNew then reconstructs the data URL from content[].data + content[].mimeType.
 * onNew also re-checks size as defense in depth (a stale attachment that
 * predates a limit change, or a programmatic add() that bypasses the
 * composer flow, would otherwise slip through).
 *
 * Exported only so the size-rejection contract can be unit-tested in isolation.
 */
export class SimpleBinaryFileAttachmentAdapter {
  public accept = "application/pdf,.pdf";

  async add(state: { file: File }) {
    const { file } = state;
    // Reject oversized files BEFORE any base64 encoding runs in send().
    // For a 100 MB pick this saves ~130 MB of string allocation and the
    // user gets the "too big" feedback instantly instead of after a freeze.
    if (file.size > CLIENT_MAX_ATTACHMENT_SIZE_BYTES) {
      const limitMb = Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024);
      throw new Error(
        `File "${file.name}" is too large (${Math.round(file.size / 1024 / 1024)} MB). The limit is ${limitMb} MB.`
      );
    }
    return {
      id: uuid(),
      type: "file" as const,
      name: file.name,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    };
  }

  async send(attachment: { id?: string; name?: string; file: File }) {
    const dataUrl = await fileToDataUrl(attachment.file);
    // Validated parse — fail closed on anything that isn't a base64 data: URL.
    // Earlier raw `indexOf(",")` / `indexOf(";")` parsing silently produced a
    // garbage mimeType for malformed URLs (no `data:` prefix, `;` before `:`,
    // empty mime, non-base64 encoding) which would then ship to the server.
    // Mirrors the server-side DATA_URL_RE in attachment-pipeline.ts.
    const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      throw new Error(
        `SimpleBinaryFileAttachmentAdapter: invalid data URL from fileToDataUrl — ` +
          `expected "data:<mime>;base64,<data>", got "${dataUrl.slice(0, 32)}…"`
      );
    }
    const mimeType = match[1];
    const data = match[2];
    const name = attachment.name ?? "";
    return {
      id: attachment.id ?? uuid(),
      type: "file" as const,
      name,
      // Carry file through so onNew can read file.size for the size check
      file: attachment.file,
      status: { type: "complete" as const },
      content: [
        {
          type: "file" as const,
          data,
          mimeType,
          filename: name || undefined,
        },
      ],
    };
  }

  async remove(_attachment: unknown): Promise<void> {
    // No-op — local files require no cleanup
  }
}

const attachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
  new CodeTextAttachmentAdapter(),
  new SimpleBinaryFileAttachmentAdapter(),
]);

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BUNDLED_MESSAGES = 200;
/**
 * Grace period before a disconnect-mid-stream is surfaced as a chat error
 * bubble. If the next reconnect succeeds and history reconciles within this
 * window, no bubble is shown — the user just sees the canonical reply land.
 *
 * Why we defer the bubble: when reconcile replaces `[..., partial-chunk,
 * error-bubble]` with the canonical history, the message list shrinks. The
 * `<AssistantMessage>` component subscribed to the trailing index reads its
 * stale snapshot on the next subscription notification and assistant-ui
 * throws "tapClientLookup: Index N out of bounds (length: N)" before React
 * can unmount it (issue #199). Adding the bubble only AFTER reconcile fails
 * keeps the message-list length stable across reconnects in the common case.
 *
 * The 2000 ms cap is comfortably above the first reconnect backoff (1000 ms)
 * plus a typical history-roundtrip; reconnect attempts further out (2 s, 4 s,
 * 5 s) still trigger the bubble because they cross this threshold.
 */
const DISCONNECT_ERROR_GRACE_MS = 2_000;

function capMessages<T>(messages: T[]): T[] {
  if (messages.length <= MAX_BUNDLED_MESSAGES) return messages;
  return messages.slice(messages.length - MAX_BUNDLED_MESSAGES);
}

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
  payloadRejected: boolean;
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
  const [payloadRejected, setPayloadRejected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const connectRef = useRef<(() => void) | null>(null);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetStuckTimerRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRecoverFromHistoryRef = useRef(false);
  /**
   * Pending-disconnect-error timer. Set by `onclose` when a stream is
   * interrupted; cleared when a successful history reconcile lands within
   * DISCONNECT_ERROR_GRACE_MS. If the timer fires, the disconnect bubble is
   * appended. See comment on `DISCONNECT_ERROR_GRACE_MS` for why this is
   * deferred (issue #199 / assistant-ui index-snapshot race).
   *
   * Carries the `retryReason` chosen at close time — `partial_stream_failure`
   * if any chunks arrived, otherwise `send_failure` — so a delayed firing
   * still classifies the failure correctly.
   */
  const pendingDisconnectErrorRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    retryReason: "partial_stream_failure" | "send_failure";
  } | null>(null);
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
    setMessages(capMessages([]));
    setIsRunning(false);
    setIsDelayed(false);
    setIsHistoryLoaded(false);
    setKnownEmptyHistory(false);
    setPayloadRejected(false);
    if (pendingDisconnectErrorRef.current) {
      clearTimeout(pendingDisconnectErrorRef.current.timer);
      pendingDisconnectErrorRef.current = null;
    }
  }

  const dispatchMessages = useCallback((action: Action) => {
    setMessages((prev) => capMessages(reduceMessages(prev, action)));
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
        setMessages((prev) =>
          capMessages([
            ...prev,
            {
              id: uuid(),
              role: "assistant",
              content: "",
              error: { timedOut: true },
              retryable: true,
              retryReason: "partial_stream_failure" as const,
            },
          ])
        );
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
        if (connectionAgentId !== agentIdRef.current || wsRef.current !== ws) return;
        setIsConnected(true);
        setReconnectExhausted(false);
        setPayloadRejected(false);
        reconnectAttemptRef.current = 0;
        ws.send(JSON.stringify({ type: "history", agentId }));

        // Flush any message that was queued while disconnected/connecting
        if (pendingMessageRef.current) {
          ws.send(pendingMessageRef.current);
          pendingMessageRef.current = null;
        }
      };

      ws.onclose = (event?: CloseEvent) => {
        if (connectionAgentId !== agentIdRef.current || wsRef.current !== ws) return;
        if (wsRef.current === ws) wsRef.current = null;
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
          setPayloadRejected(true);
          setMessages((prev) =>
            capMessages([
              ...prev,
              {
                id: uuid(),
                role: "assistant",
                content: "",
                error: {
                  payloadTooLarge: true,
                  message: `File too large to send. Please use a file smaller than ${Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024)} MB.`,
                },
              },
            ])
          );
          return;
        }

        // If a stream was in progress, defer injecting the disconnect error
        // bubble — give the imminent reconnect+history-reconcile a chance to
        // land first. If reconcile arrives within DISCONNECT_ERROR_GRACE_MS,
        // it will clear this timer and the bubble is never shown. This keeps
        // the message-list length stable across reconnects in the common case
        // (avoids issue #199 / assistant-ui index-snapshot race).
        if (isRunningRef.current) {
          isRunningRef.current = false;
          setIsRunning(false);
          if (pendingDisconnectErrorRef.current) {
            clearTimeout(pendingDisconnectErrorRef.current.timer);
          }
          const retryReason = hasReceivedChunkRef.current
            ? ("partial_stream_failure" as const)
            : ("send_failure" as const);
          const timer = setTimeout(() => {
            pendingDisconnectErrorRef.current = null;
            if (!mountedRef.current) return;
            setMessages((prev) =>
              capMessages([
                ...prev,
                {
                  id: uuid(),
                  role: "assistant",
                  content: "",
                  error: { disconnected: true },
                  retryable: true,
                  retryReason,
                },
              ])
            );
          }, DISCONNECT_ERROR_GRACE_MS);
          pendingDisconnectErrorRef.current = { timer, retryReason };
        } else {
          setIsRunning(false);
        }

        setIsHistoryLoaded(false);
        setKnownEmptyHistory(false);
        setPayloadRejected(false);

        if (mountedRef.current && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
          shouldRecoverFromHistoryRef.current = true;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 5000);
          reconnectAttemptRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, delay);
        } else if (mountedRef.current) {
          setReconnectExhausted(true);
        }
      };

      ws.onerror = () => {
        if (connectionAgentId !== agentIdRef.current || wsRef.current !== ws) return;
        // onclose always fires after onerror — let onclose handle isRunning and
        // the disconnect error injection so the user sees the right feedback.
        setIsConnected(false);
        clearStuckTimer();
      };

      ws.onmessage = (event) => {
        if (connectionAgentId !== agentIdRef.current || wsRef.current !== ws) return;
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
            const serverMessages: Array<{
              role: string;
              content: string;
              timestamp?: string;
              files?: WsFileMeta[];
            }> = data.messages ?? [];
            // Successful history reconcile within the grace window — cancel
            // the deferred disconnect bubble so the user just sees the
            // canonical reply land without a transient error bubble. See
            // DISCONNECT_ERROR_GRACE_MS (issue #199).
            if (
              shouldRecoverFromHistoryRef.current &&
              serverMessages.length > 0 &&
              pendingDisconnectErrorRef.current
            ) {
              clearTimeout(pendingDisconnectErrorRef.current.timer);
              pendingDisconnectErrorRef.current = null;
            }
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
              // Round-tripped from the server's parseAttachmentBlock — server
              // strips the in-message markup and surfaces the file metadata
              // here so the file chip renders on reload.
              ...(msg.files && msg.files.length > 0 ? { files: msg.files } : {}),
            }));
            const shouldRecoverFromHistory = shouldRecoverFromHistoryRef.current;
            setMessages((prev) => {
              if (prev.length === 0) {
                return capMessages(historyMessages);
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
                  return capMessages(historyMessages);
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
                return capMessages([
                  ...filtered.slice(0, -1),
                  { ...last, content: last.content + data.content },
                ]);
              }
              return capMessages([
                ...filtered,
                {
                  id: data.messageId,
                  role: "assistant",
                  content: data.content,
                  timestamp: new Date().toISOString(),
                },
              ]);
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
              : data.code === "attachment_invalid"
                ? { attachmentInvalid: true, message: data.message }
                : { message: data.message || "An unknown error occurred." };

            setMessages((prev) =>
              capMessages([
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
              ])
            );
            isRunningRef.current = false;
            setIsRunning(false);
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      wsRef.current = ws;
    }

    connectRef.current = connect;
    connect();

    return () => {
      mountedRef.current = false;
      if (connectRef.current === connect) {
        connectRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
      }
      if (pendingDisconnectErrorRef.current) {
        clearTimeout(pendingDisconnectErrorRef.current.timer);
        pendingDisconnectErrorRef.current = null;
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
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      pendingMessageRef.current = payload;
      if (
        ws?.readyState === WebSocket.CONNECTING ||
        ws?.readyState === WebSocket.CLOSING ||
        reconnectTimerRef.current
      ) {
        return;
      }
      connectRef.current?.();
    }
  }, []);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const textParts = message.content.filter((part) => part.type === "text");
      const text = textParts.map((part) => ("text" in part ? part.text : "")).join("");

      // Extract attachments (assistant-ui puts them there, not in content)
      const attachments =
        (
          message as {
            attachments?: Array<{
              type: string;
              name?: string;
              /** Original File object — carried through send() so onNew can read file.size */
              file?: File;
              content?: Array<{
                type: string;
                image?: string;
                /** Image data URL (SimpleImageAttachmentAdapter) */
                url?: string;
                /** Binary file base64 data (SimpleBinaryFileAttachmentAdapter FileMessagePart) */
                data?: string;
                mimeType?: string;
                filename?: string;
              }>;
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

      // Extract binary file attachments (PDF) added by SimpleBinaryFileAttachmentAdapter.
      // After send(), content parts carry base64 `data` + `mimeType` (FileMessagePart shape).
      // Reconstruct the data URL here so the WS payload stays the same for the server.
      const binaryFiles: Array<{ url: string; name: string; sizeBytes: number }> = [];
      for (const att of attachments) {
        if (att.type === "file" && att.content) {
          for (const c of att.content) {
            if (c.type === "file" && c.data) {
              const dataUrl = `data:${c.mimeType};base64,${c.data}`;
              binaryFiles.push({
                url: dataUrl,
                name: att.name ?? c.filename ?? "file",
                // Use the original File's byte count when available; fall back to
                // computing from base64 length (within a few bytes of actual size).
                sizeBytes: att.file?.size ?? Math.ceil((c.data.length * 3) / 4),
              });
            }
          }
        }
      }

      // Size check for binary files (no compression path — reject immediately if over limit)
      for (const f of binaryFiles) {
        if (f.sizeBytes > CLIENT_MAX_ATTACHMENT_SIZE_BYTES) {
          setMessages((prev) => [
            ...prev,
            {
              id: uuid(),
              role: "assistant",
              content: "",
              error: buildAttachmentTooLargeError(),
            },
          ]);
          return;
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
          setMessages((prev) =>
            capMessages([
              ...prev,
              {
                id: uuid(),
                role: "assistant",
                content:
                  "Couldn't process this image format. Please convert it to JPEG, PNG, or WebP and try again.",
              },
            ])
          );
          return;
        }

        // Check size AFTER compression — reject if still too large for the WS frame.
        // Checking file.size (bytes) avoids materialising the full data URL string
        // just to count characters.
        if (result.file.size > CLIENT_MAX_ATTACHMENT_SIZE_BYTES) {
          setMessages((prev) =>
            capMessages([
              ...prev,
              {
                id: uuid(),
                role: "assistant",
                content: "",
                error: buildAttachmentTooLargeError(),
              },
            ])
          );
          return;
        }

        compressedImages.push(await fileToDataUrl(result.file));
      }

      if (!text.trim() && compressedImages.length === 0 && binaryFiles.length === 0) return;
      setPayloadRejected(false);

      // Combine images and binary files into a single content array for the WS payload.
      // Server-side processIncomingAttachments processes all image_url parts uniformly.
      const allFileUrls = [...compressedImages, ...binaryFiles.map((f) => f.url)];
      const allFilenames = [
        // Images don't have meaningful filenames in the current flow; empty strings
        // tell the server to fall back to its "upload" default for those indices.
        ...compressedImages.map(() => ""),
        ...binaryFiles.map((f) => f.name),
      ];
      // Only pass filenames when at least one binary file is present — image-only
      // sends don't benefit from the filename array (server falls back to "upload").
      const hasFilenames = binaryFiles.length > 0;

      const clientMessageId = uuid();

      // A new turn starts — cancel any pending deferred disconnect bubble
      // from a prior interrupted turn so the bubble doesn't land in the
      // middle of a fresh exchange.
      if (pendingDisconnectErrorRef.current) {
        clearTimeout(pendingDisconnectErrorRef.current.timer);
        pendingDisconnectErrorRef.current = null;
      }

      // Add the user message directly with status: "sending" and an ISO timestamp
      // for display. The reducer is used only for status transitions (ack, timeout,
      // etc.) on already-added messages — not for the initial insertion, so we keep
      // the hook's string timestamp format intact.
      setMessages((prev) =>
        capMessages([
          ...prev,
          {
            id: clientMessageId,
            role: "user",
            content: text,
            timestamp: new Date().toISOString(),
            status: "sending",
            ...(compressedImages.length > 0 && { images: compressedImages }),
            ...(binaryFiles.length > 0 && {
              files: binaryFiles.map((f) => ({
                filename: f.name,
                // f.url is `data:<mime>;base64,<data>` — extract mime up to the `;`
                mimeType: f.url.slice("data:".length, f.url.indexOf(";")),
              })),
            }),
          },
        ])
      );

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
        content: buildWsContent(text, allFileUrls.length > 0 ? allFileUrls : undefined),
        ...(hasFilenames && { filenames: allFilenames }),
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
    payloadRejected,
    isOrphaned,
    onRetryContinue,
    onRetryResend,
  };
}
