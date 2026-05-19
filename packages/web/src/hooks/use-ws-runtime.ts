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
import { upstreamFormatErrorSchema } from "@/lib/schemas/chat-frames";
import { reduceMessages, type Action } from "./message-status-reducer";
import type { MessageStatus } from "./message-status-reducer";
import { isOrphaned as computeIsOrphaned } from "./orphan-detector";
import {
  CLIENT_IMAGE_COMPRESSION_TARGET_BYTES,
  CLIENT_MAX_ATTACHMENT_SIZE_BYTES,
} from "@/lib/limits";
import { compressImageForChat } from "@/lib/image-compression";
import { dataUrlToFile, fileToDataUrl } from "@/lib/data-url";
import { mimeFromFilename } from "@/lib/attachment-mime";

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
 * Cap on the Tier 2b pre-history frame buffer. The buffer holds chunks
 * that arrive on a fresh ws between `addListener` (server-side) and the
 * history response. Typical drain time is ~100ms; entries beyond the cap
 * indicate a broken server response and we log + drop the oldest rather
 * than risk OOM-ing the tab.
 */
const FRAME_BUFFER_MAX = 1000;

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

/**
 * Adapter for source-code files whose content the model reads inline as text.
 *
 * The plain-text / CSV / Markdown / JSON / YAML types are deliberately NOT
 * listed here: those are workspace data files (issue #392) handled by
 * SimpleBinaryFileAttachmentAdapter, which uploads them so the agent can read
 * them with `pinchy_read`. Because CompositeAttachmentAdapter dispatches to the
 * FIRST adapter whose `accept` matches and this adapter precedes the binary
 * one, leaving those types here would inline them and bypass the workspace.
 */
class CodeTextAttachmentAdapter extends SimpleTextAttachmentAdapter {
  public override accept =
    "text/html,text/xml,text/css,application/javascript,application/typescript,.js,.ts,.tsx,.jsx,.py,.rs,.go,.sh,.sql,.toml";
}

/**
 * Adapter for files uploaded to the agent workspace, read there via
 * `pinchy_read`.
 *
 * Handles PDFs plus the text data formats the server accepts as workspace
 * uploads (issue #392): CSV, plain text, Markdown, JSON, YAML. These mirror
 * `ALLOWED_TEXT_MIMES` in upload-validation.ts. Both MIME types and extensions
 * are listed because browsers assign an empty `File.type` to some of them
 * (notably .yaml/.md) — the extension is then the only signal.
 *
 * Audio is tracked in #321 — it requires a transcription pipeline that does
 * not yet exist; accepting audio here without it would persist files the agent
 * has no way to read.
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
  public accept =
    "application/pdf,.pdf,text/csv,.csv,text/plain,.txt,text/markdown,.md,.markdown,application/json,.json,text/yaml,.yaml,.yml";

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
    // non-base64 encoding) which would then ship to the server.
    // The mime group is `*` (not the server DATA_URL_RE's `+`) because browsers
    // leave `File.type` empty for some text formats — that case is recovered
    // from the extension below, and a non-empty mime is always sent onward.
    const match = /^data:([^;,]*);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      throw new Error(
        `SimpleBinaryFileAttachmentAdapter: invalid data URL from fileToDataUrl — ` +
          `expected "data:<mime>;base64,<data>", got "${dataUrl.slice(0, 32)}…"`
      );
    }
    const data = match[2];
    const name = attachment.name ?? "";
    // Prefer the canonical text MIME derived from the extension: browsers leave
    // File.type empty for .yaml/.md and sometimes mislabel text files as
    // application/octet-stream. Both forms fail the server's text allowlist, so
    // the extension is the more reliable signal. PDFs/images have no extension
    // entry, so they keep the data-URL MIME. Fail closed if neither yields a
    // MIME — a workspace upload with an empty content-type is rejected anyway.
    const mimeType = mimeFromFilename(name) ?? match[1];
    if (!mimeType) {
      throw new Error(
        `SimpleBinaryFileAttachmentAdapter: could not determine a MIME type for ` +
          `"${name}" — File.type was empty and the extension is not a known text format.`
      );
    }
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

/**
 * Adapter for Office documents the model needs as readable text.
 *
 * Currently: .docx only. The file is a ZIP archive of XML; reading it via
 * the plain-text adapter would ship the model the literal "PK…" bytes of
 * the archive. We extract the text with mammoth at upload time and ship it
 * as a text part, mirroring SimpleTextAttachmentAdapter for .txt files.
 *
 * Mammoth is dynamically imported inside send() so it doesn't land in the
 * initial chat bundle for users who never attach a .docx.
 *
 * Filename is XML-escaped into the `<attachment name="…">` wrapper so the
 * agent can cite the source document even when the name contains spaces,
 * ampersands, or angle brackets.
 *
 * Exported only so the size-rejection contract and the wrapper escaping
 * can be unit-tested in isolation.
 */
export class OfficeDocumentAttachmentAdapter {
  public accept = "application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx";

  async add(state: { file: File }) {
    const { file } = state;
    if (file.size > CLIENT_MAX_ATTACHMENT_SIZE_BYTES) {
      const limitMb = Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024);
      throw new Error(
        `File "${file.name}" is too large (${Math.round(file.size / 1024 / 1024)} MB). The limit is ${limitMb} MB.`
      );
    }
    return {
      id: uuid(),
      type: "document" as const,
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    };
  }

  async send(attachment: { id?: string; name: string; file: File }) {
    const arrayBuffer = await attachment.file.arrayBuffer();
    const { default: mammoth } = await import("mammoth");
    const { default: TurndownService } = await import("turndown");
    const { gfm } = await import("turndown-plugin-gfm");

    const { value: html } = await mammoth.convertToHtml({
      arrayBuffer,
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
    });

    const normalizedHtml = normalizeDocxTableHtml(html);

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    turndown.use(gfm);
    turndown.addRule("strip-image", {
      filter: "img",
      replacement: () => "[image]",
    });
    const value = turndown.turndown(normalizedHtml);

    return {
      id: attachment.id ?? uuid(),
      type: "document" as const,
      name: attachment.name,
      file: attachment.file,
      status: { type: "complete" as const },
      content: [
        {
          type: "text" as const,
          text: `<attachment name="${escapeXmlAttribute(attachment.name)}">\n${value}\n</attachment>`,
        },
      ],
    };
  }

  async remove(): Promise<void> {
    // No-op — local files require no cleanup
  }
}

/**
 * Normalize mammoth-generated table HTML so turndown's GFM plugin produces
 * pipe tables.
 *
 * Mammoth emits `<table><tr><td>…</td></tr></table>` — no `<thead>`, no
 * `<th>`, and cell content wrapped in `<p>`. The turndown-plugin-gfm table
 * rule only activates when the first row is a heading row (all-`<th>` or
 * inside `<thead>`). This function:
 *  1. Strips `<p>` wrappers inside cells so content is inline.
 *  2. Promotes the first `<tr>` into a `<thead>` with `<th>` cells.
 *
 * Mirrors the same helper in `packages/plugins/pinchy-files/docx-extract.ts`.
 */
function normalizeDocxTableHtml(html: string): string {
  // Step 1: strip <p> wrappers inside <td>/<th> cells.
  let out = html.replace(/<(td|th)([^>]*)><p>([\s\S]*?)<\/p><\/(td|th)>/g, "<$1$2>$3</$1>");

  // Step 2: for each <table>…</table>, promote the first <tr> into a
  // <thead> with <th> cells. Mammoth emits no <tbody>, so rows sit
  // directly under <table>.
  out = out.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner: string) => {
    const firstRowMatch = inner.match(/^(<tr>[\s\S]*?<\/tr>)/);
    if (!firstRowMatch) return `<table>${inner}</table>`;
    const firstRow = firstRowMatch[1];
    const rest = inner.slice(firstRow.length);
    const headingRow = firstRow.replace(/<td([^>]*)>/g, "<th$1>").replace(/<\/td>/g, "</th>");
    return `<table><thead>${headingRow}</thead><tbody>${rest}</tbody></table>`;
  });

  return out;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const attachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
  new CodeTextAttachmentAdapter(),
  new OfficeDocumentAttachmentAdapter(),
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

/**
 * Sanitize a server-provided identifier before embedding it in a log
 * message. Defends against log injection (CodeQL js/log-injection): if a
 * malicious Pinchy server (or a buggy one round-tripping unsanitized user
 * input) put control characters or newlines into a `runId`, the raw
 * value flowing into `console.warn` could fake new log lines or break
 * structured-log parsers.
 *
 * Allowed alphabet matches what OpenClaw actually emits for runIds
 * (UUID-like alphanumeric + dashes + underscores). Anything else
 * collapses to `<invalid>` so the warning still tells operators "something
 * unexpected" without leaking the unsafe value verbatim.
 */
export function safeLogId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value : "<invalid>";
}

/**
 * Decide whether the local message list should be wholly replaced with the
 * server's history frame after a disconnect+reconnect cycle.
 *
 * The flag `shouldRecoverFromHistory` is set when the WS closed or a page-
 * lifecycle event suspended us — i.e. we may have missed frames while the
 * client wasn't listening. Server history is the canonical record in that
 * case, so we adopt it.
 *
 * Conditions:
 *   - Recovery flag is set (otherwise this is an ordinary initial load —
 *     the status reducer handles in-flight reconciliation).
 *   - History is non-empty (an empty frame can mean "upstream OpenClaw is
 *     unreachable", which is never canonical when we already have content).
 *   - The last non-error local message either is an assistant turn
 *     (mid-stream disconnect — server is canonical), OR is an acked user
 *     turn AND server history is strictly longer than what we have locally.
 *
 * The second clause is the fix for issue #310: when the WS drops between
 * `ack` and the first chunk, the local list ends with an acked user
 * message. OpenClaw still completes the turn and persists the reply, so
 * server history has [..., user, assistant] while local has [..., user].
 * Without this clause the reconcile gate fires `false`, the synthetic
 * "The agent didn't respond." orphan bubble surfaces, and retries pile up
 * duplicate user turns.
 *
 * Why the `status === "sent"` guard: a "sending" user message is one we
 * queued during the disconnect (see `pendingMessagesRef` handling). The
 * server hasn't acknowledged it yet, so a longer history must be from a
 * previous turn — replacing would silently drop the queued message.
 *
 * Known limit (in scope for #310 Tier 2, not this gate): the `status ===
 * "sent"` guard also excludes user messages whose `status` is `undefined`,
 * which happens when the last user message in `prevMessages` came from a
 * prior history reconcile (history-derived messages don't carry a delivery
 * status). This blocks reconcile in a rare multi-tab scenario where Tab A
 * opens a chat with an in-flight assistant turn from Tab B, then Tab A's
 * WS drops before the chunks arrive. Tier 2 closes this via the server-
 * side `activeRun` signal — see #310 follow-ups.
 */
export function shouldReplaceLocalWithServerHistory(
  prevMessages: WsMessage[],
  historyMessages: WsMessage[],
  shouldRecoverFromHistory: boolean
): boolean {
  if (!shouldRecoverFromHistory) return false;
  if (historyMessages.length === 0) return false;

  const lastNonError = [...prevMessages].reverse().find((m) => !m.error);
  if (!lastNonError) return true;

  if (lastNonError.role === "assistant") return true;

  // lastNonError.role === "user"
  return lastNonError.status === "sent" && historyMessages.length > prevMessages.length;
}

export function useWsRuntime(agentId: string): {
  runtime: AssistantRuntime;
  isRunning: boolean;
  isConnected: boolean;
  isDelayed: boolean;
  isHistoryLoaded: boolean;
  isReconcilingMessages: boolean;
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
  const [isReconcilingMessages, setIsReconcilingMessages] = useState(false);
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
  const reconcileApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcileFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<WsMessage[]>([]);
  const shouldRecoverFromHistoryRef = useRef(false);
  const lifecycleSuspendedRef = useRef(false);
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
   * Tier 2b (#310): between sending a history request and receiving the
   * matching history frame, any non-history frame (chunk, done, error,
   * thinking, ack) is buffered into `frameBufferRef` and drained AFTER
   * the history reconcile. This closes the race where the server's
   * `addListener` makes the new ws receive in-flight chunks before the
   * history snapshot arrives — without the buffer, those chunks would
   * land on whatever stale local state existed pre-reconcile and then
   * be wiped by the reconcile itself.
   */
  const pendingHistoryRef = useRef(false);
  const frameBufferRef = useRef<unknown[]>([]);
  /**
   * Server-correlated runId for the in-flight chat turn (Tier 2b). Set
   * when a history frame includes the `activeRun` signal and used by
   * downstream UX (e.g. matching `chat.run_timed_out` error frames) so
   * the client knows which run timed out vs. which retry produced the
   * error.
   */
  const inflightRunIdRef = useRef<string | null>(null);
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
  //
  // Timers MUST be cleared synchronously here, not in the [agentId] useEffect
  // cleanup: that cleanup runs after commit, leaving a race window where
  // a pending timer can fire between render and cleanup and write OLD-agent
  // data into NEW-agent state. The timer callbacks below (reconcileApply,
  // reconcileFinish, pendingDisconnectError) don't guard on agentIdRef.current,
  // so a single stale tick can corrupt the new agent's message list.
  // The react-hooks/purity rule warns against reading refs during render, but
  // here it's the only way to close the race — the timing requirement wins.
  const [prevAgentId, setPrevAgentId] = useState(agentId);
  if (prevAgentId !== agentId) {
    setPrevAgentId(agentId);
    setMessages(capMessages([]));
    setIsRunning(false);
    setIsDelayed(false);
    setIsHistoryLoaded(false);
    setIsReconcilingMessages(false);
    setKnownEmptyHistory(false);
    setPayloadRejected(false);
    // Synchronous timer cleanup is the entire point of doing this in render
    // (see comment above). Deferring it to useEffect would defeat the
    // race-prevention this block exists for.
    // eslint-disable-next-line react-hooks/refs
    if (reconcileApplyTimerRef.current) {
      // eslint-disable-next-line react-hooks/refs
      clearTimeout(reconcileApplyTimerRef.current);
      // eslint-disable-next-line react-hooks/refs
      reconcileApplyTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/refs
    if (reconcileFinishTimerRef.current) {
      // eslint-disable-next-line react-hooks/refs
      clearTimeout(reconcileFinishTimerRef.current);
      // eslint-disable-next-line react-hooks/refs
      reconcileFinishTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/refs
    if (pendingDisconnectErrorRef.current) {
      // eslint-disable-next-line react-hooks/refs
      clearTimeout(pendingDisconnectErrorRef.current.timer);
      // eslint-disable-next-line react-hooks/refs
      pendingDisconnectErrorRef.current = null;
    }
  }

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

    function clearReconcileTimers() {
      if (reconcileApplyTimerRef.current) {
        clearTimeout(reconcileApplyTimerRef.current);
        reconcileApplyTimerRef.current = null;
      }
      if (reconcileFinishTimerRef.current) {
        clearTimeout(reconcileFinishTimerRef.current);
        reconcileFinishTimerRef.current = null;
      }
    }

    function clearUiTimers() {
      clearStuckTimer();
      clearReconcileTimers();
      setIsReconcilingMessages(false);
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
        delayTimerRef.current = null;
      }
      if (pendingDisconnectErrorRef.current) {
        clearTimeout(pendingDisconnectErrorRef.current.timer);
        pendingDisconnectErrorRef.current = null;
      }
      for (const timer of pendingAckTimers.current.values()) {
        clearTimeout(timer);
      }
      pendingAckTimers.current.clear();
    }

    function stageDestructiveHistoryReconcile(historyMessages: WsMessage[]) {
      clearReconcileTimers();
      setIsReconcilingMessages(true);
      reconcileApplyTimerRef.current = setTimeout(() => {
        reconcileApplyTimerRef.current = null;
        setMessages(capMessages(historyMessages));
        reconcileFinishTimerRef.current = setTimeout(() => {
          reconcileFinishTimerRef.current = null;
          setIsReconcilingMessages(false);
        }, 16);
      }, 0);
    }

    function suspendForPageLifecycle() {
      lifecycleSuspendedRef.current = true;
      clearUiTimers();
      setIsDelayed(false);
      setIsConnected(false);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      shouldRecoverFromHistoryRef.current = true;
      wsRef.current?.close();
    }

    function recoverFromPageLifecycle() {
      if (!lifecycleSuspendedRef.current) return;
      lifecycleSuspendedRef.current = false;
      shouldRecoverFromHistoryRef.current = true;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Tier 2b: same buffer-then-drain protocol as ws.onopen — the
        // server may broadcast in-flight chunks between the addListener
        // (which runs in handleHistory) and the history-response send.
        pendingHistoryRef.current = true;
        frameBufferRef.current = [];
        wsRef.current.send(JSON.stringify({ type: "history", agentId }));
      } else {
        connect();
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        suspendForPageLifecycle();
      } else if (document.visibilityState === "visible") {
        recoverFromPageLifecycle();
      }
    }

    function handlePageHide() {
      suspendForPageLifecycle();
    }

    function handlePageShow() {
      recoverFromPageLifecycle();
    }

    function handleOffline() {
      suspendForPageLifecycle();
    }

    function handleOnline() {
      recoverFromPageLifecycle();
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
        // Tier 2b: arm the pre-history buffer ONLY when we're in a
        // recovery context (set by `onclose` on the previous connection
        // or by a page-lifecycle resume). On an initial load there's no
        // active run on the server yet — buffering would just stall the
        // first chunk for no benefit and break tests that exercise the
        // chunk path without preceding history. The race we're guarding
        // against (chunks arriving via `addListener` before the history
        // response) can only happen on reconnect, because the server
        // can't have a listener for a ws it hasn't seen yet.
        if (shouldRecoverFromHistoryRef.current) {
          pendingHistoryRef.current = true;
          frameBufferRef.current = [];
        }
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
        // Tier 2b: drop any pre-history buffer from the dying connection
        // so it can't bleed into the next ws's drain. The next onopen
        // re-arms pendingHistoryRef before sending its own history req.
        pendingHistoryRef.current = false;
        frameBufferRef.current = [];
        if (delayTimerRef.current) {
          clearTimeout(delayTimerRef.current);
          delayTimerRef.current = null;
        }

        if (lifecycleSuspendedRef.current) {
          isRunningRef.current = false;
          setIsRunning(false);
          setIsHistoryLoaded(false);
          setKnownEmptyHistory(false);
          return;
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

      // Tier 2b: extracted so the buffered-frame drain after history
      // reconcile can reuse the same dispatch logic that live frames
      // travel through. Keeping the dispatch surface single-sourced
      // means a future chunk-type addition can't accidentally diverge
      // between the live and replay paths. `any` matches the implicit
      // return type of `JSON.parse` — the same permissiveness the prior
      // inline handler relied on for `data.messageId`, `data.content`,
      // etc. Tightening this would cascade dozens of `as string` casts
      // for marginal type safety on a shape the server fully controls.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const processFrame = (data: any) => {
        if (data.type === "openclaw:restarting") {
          triggerRestart();
          return;
        }

        if (data.type === "openclaw_status") {
          setIsOpenClawConnected(!!data.connected);
          return;
        }

        // Tier 2b: between the moment we requested history and the moment
        // the history frame arrives, the server may broadcast in-flight
        // chunks to us via the listener set. Buffer those so they apply
        // ON TOP of the reconciled history rather than to whatever stale
        // local state existed pre-reconcile (which would be wiped by the
        // reconcile itself). Control frames above are processed
        // immediately; everything else is held.
        //
        // Defensive cap: in practice the buffer drains within ~100ms
        // (history fetch latency). A buffer that exceeds the cap means
        // either a server bug (history frame never arrives) or an
        // adversarial server flooding chunks. Log + drop oldest so we
        // don't OOM the tab.
        if (pendingHistoryRef.current && data.type !== "history") {
          if (frameBufferRef.current.length >= FRAME_BUFFER_MAX) {
            console.warn(
              `[use-ws-runtime] pre-history frame buffer hit ${FRAME_BUFFER_MAX} entries — dropping oldest. ` +
                "This indicates the server's history response is delayed; investigate handleHistory latency."
            );
            frameBufferRef.current.shift();
          }
          frameBufferRef.current.push(data);
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

          // Tier 2b: if the server reports an in-flight run for this
          // session, anchor the last assistant message in the reconciled
          // history to the server-side `currentMessageId`. Subsequent
          // chunks (already buffered or arriving live on the new ws)
          // merge into THIS message by id-equality, so the user sees a
          // single continuous bubble instead of an orphan + a fresh
          // duplicate. Also preserve isRunning across the reconnect so
          // the spinner doesn't flicker.
          const activeRun = (
            data as {
              activeRun?: { runId: string; messageId: string; startedAt: number };
            }
          ).activeRun;
          if (activeRun) {
            for (let i = historyMessages.length - 1; i >= 0; i--) {
              if (historyMessages[i].role === "assistant") {
                historyMessages[i].id = activeRun.messageId;
                break;
              }
            }
            isRunningRef.current = true;
            setIsRunning(true);
            inflightRunIdRef.current = activeRun.runId;
            if (pendingDisconnectErrorRef.current) {
              clearTimeout(pendingDisconnectErrorRef.current.timer);
              pendingDisconnectErrorRef.current = null;
            }
          }
          const shouldRecoverFromHistory = shouldRecoverFromHistoryRef.current;
          const prevMessages = messagesRef.current;
          const shouldReplaceWithHistory = shouldReplaceLocalWithServerHistory(
            prevMessages,
            historyMessages,
            shouldRecoverFromHistory
          );
          // Tier 2b: skip the destructive staged remount when an activeRun
          // signal is in play. The staged path uses a setTimeout(0) to
          // remount, but drainBuffer fires synchronously — so buffered
          // chunks would land on stale state and then be wiped by the
          // deferred stage. activeRun semantically means "the in-flight
          // turn IS the truth, don't tear down state in a way that loses
          // the resume buffer", so we take the synchronous setMessages
          // path which keeps drain consistent with reconcile.
          const shouldStageReplace =
            shouldReplaceWithHistory &&
            prevMessages.length > 0 &&
            !activeRun &&
            (historyMessages.length < prevMessages.length || prevMessages.some((m) => m.error));

          // Tier 2b: drain helper — runs once history has been applied
          // (either branch below) so buffered chunks merge into the
          // freshly-reconciled message list, including the activeRun-
          // anchored assistant turn.
          const drainBuffer = () => {
            pendingHistoryRef.current = false;
            const buffered = frameBufferRef.current;
            frameBufferRef.current = [];
            for (const frame of buffered) {
              processFrame(frame);
            }
          };

          if (shouldStageReplace) {
            stageDestructiveHistoryReconcile(historyMessages);
            shouldRecoverFromHistoryRef.current = false;
            setIsHistoryLoaded(true);
            drainBuffer();
            return;
          }

          setMessages((prev) => {
            if (prev.length === 0) {
              return capMessages(historyMessages);
            }
            // After reconnects, replace local messages with canonical history
            // from the server. The conditions are gathered in
            // shouldReplaceLocalWithServerHistory above — see that helper's
            // doc for the full rationale (esp. the issue #310 fix for an
            // acked-user-but-no-chunk window). We intentionally replace even
            // if the last local message is a synthetic disconnect-error
            // bubble, because the server's history is the ground truth.
            //
            // The helper is re-evaluated here against React's `prev` (not
            // `messagesRef.current` from the outer scope) because under
            // concurrent rendering the two snapshots can diverge — a stale
            // outer evaluation must never override what React holds as the
            // current authoritative state inside the setter.
            if (
              shouldReplaceLocalWithServerHistory(prev, historyMessages, shouldRecoverFromHistory)
            ) {
              return capMessages(historyMessages);
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
          drainBuffer();
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
          // Tier 2b: the run finished cleanly. Drop the in-flight runId
          // so the next turn's activeRun signal (if any) replaces it.
          inflightRunIdRef.current = null;
        }

        if (data.type === "error") {
          if (delayTimerRef.current) {
            clearTimeout(delayTimerRef.current);
            delayTimerRef.current = null;
          }
          clearStuckTimer();
          setIsDelayed(false);

          // Tier 2b: cross-check runId on watchdog-timeout error frames
          // against the in-flight runId we recorded from the activeRun
          // signal. A mismatch means the server forcibly aborted some
          // OTHER run for this session (e.g. a stale background turn) —
          // ignore it so we don't surface a misleading timeout for the
          // run the user is actually watching. Frames without runId
          // (every non-watchdog error path) pass through unchanged.
          if (
            data.runTimedOut === true &&
            typeof data.runId === "string" &&
            inflightRunIdRef.current !== null &&
            data.runId !== inflightRunIdRef.current
          ) {
            console.warn(
              `[use-ws-runtime] ignoring run_timed_out for ${safeLogId(data.runId)} — current in-flight run is ${safeLogId(inflightRunIdRef.current)}`
            );
            return;
          }

          // Defense-in-depth: parse the structured upstream-format-error
          // payload with the zod schema instead of trusting the inbound
          // shape. A stale server or malformed frame must NOT be able to
          // render the "Retry usually clears it" bubble for an unrelated
          // error — that would lie to the user about the cause and the
          // recovery path. On parse failure the bare providerError still
          // surfaces via the generic bubble. Issue #338.
          const upstreamFormatErrorParsed = data.upstreamFormatError
            ? upstreamFormatErrorSchema.safeParse(data.upstreamFormatError)
            : null;
          const upstreamFormatError = upstreamFormatErrorParsed?.success
            ? upstreamFormatErrorParsed.data
            : undefined;

          const error: ChatError = data.providerError
            ? {
                agentName: data.agentName,
                providerError: data.providerError,
                hint: data.hint,
                modelUnavailable: data.modelUnavailable,
                upstreamFormatError,
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
          // Clear the in-flight runId so a follow-up retry's activeRun
          // signal can replace it cleanly.
          inflightRunIdRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        if (connectionAgentId !== agentIdRef.current || wsRef.current !== ws) return;
        try {
          const data = JSON.parse(event.data);
          processFrame(data);
        } catch {
          // Ignore unparseable messages
        }
      };

      wsRef.current = ws;
    }

    connectRef.current = connect;
    connect();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("freeze", handlePageHide);
    document.addEventListener("resume", handlePageShow);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      mountedRef.current = false;
      if (connectRef.current === connect) {
        connectRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("freeze", handlePageHide);
      document.removeEventListener("resume", handlePageShow);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      clearReconcileTimers();
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
    isReconcilingMessages,
    hasInitialContent,
    isOpenClawConnected,
    reconnectExhausted,
    payloadRejected,
    isOrphaned,
    onRetryContinue,
    onRetryResend,
  };
}
