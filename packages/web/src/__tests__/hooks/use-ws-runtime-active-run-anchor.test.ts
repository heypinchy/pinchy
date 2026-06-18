/**
 * Regression guard (#470): on the streaming-resume path, the reconciled message
 * list handed to assistant-ui must ALWAYS end with an assistant message while
 * the run is in flight. Otherwise assistant-ui appends its own optimistic
 * assistant (isRunning && last !== assistant), whose count leads its per-message
 * resource list by one and crashes ThreadPrimitive.Messages with a
 * tapClientLookup out-of-bounds index ("Something went wrong").
 *
 * This file mocks @assistant-ui/react to the identity function so
 * `runtime.messages` exposes the exact convertedMessages array that would be fed
 * to the real runtime — we assert its trailing message directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";

vi.mock("@/lib/image-compression", () => ({
  compressImageForChat: vi.fn(async (file: File) => ({ ok: true, file, skipped: true })),
}));
vi.mock("@/lib/upload-attachment", () => ({ uploadAttachment: vi.fn() }));
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ isRestarting: false, triggerRestart: vi.fn() }),
}));
vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: (config: any) => config,
  SimpleImageAttachmentAdapter: class {
    accept = "image/*";
  },
  SimpleTextAttachmentAdapter: class {
    accept = "text/plain";
  },
  CompositeAttachmentAdapter: class {
    accept = "";
    constructor() {}
  },
}));

let wsInstances: MockWebSocket[] = [];
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    wsInstances.push(this);
  }
  simulateOpen() {
    this.onopen?.(new Event("open"));
  }
  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}
vi.stubGlobal("WebSocket", MockWebSocket);

type Converted = { id: string; role: string };
function messagesOf(runtime: unknown): Converted[] {
  return ((runtime as { messages?: Converted[] }).messages ?? []) as Converted[];
}

describe("useWsRuntime — activeRun reconcile anchors a trailing assistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("appends a trailing assistant when history ends in the user turn (unpersisted reply)", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "list one..ten" }],
        activeRun: { runId: "run-1", messageId: "srv-1", startedAt: 1000 },
      })
    );

    const msgs = messagesOf(result.current.runtime);
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.id).toBe("srv-1");
  });

  it("seeds the in-flight bubble with the server's resume buffer (partialContent)", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());
    // Reload mid-stream: the words "one two three" already streamed before the
    // reload. History has only the user turn; the server replays the accumulated
    // text via activeRun.partialContent so it isn't lost.
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "list one..ten" }],
        activeRun: {
          runId: "run-1",
          messageId: "srv-1",
          startedAt: 1000,
          partialContent: "one two three",
        },
      })
    );

    const msgs = (
      result.current.runtime as { messages?: { id: string; role: string; content?: unknown }[] }
    ).messages!;
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.id).toBe("srv-1");
    // The pre-reload content is recovered, not lost.
    expect(JSON.stringify(last.content)).toContain("one two three");
  });

  it("preserves the already-streamed prefix when a FULL reload races live deltas ahead of the late history response", () => {
    // Full page reload mid-stream. Unlike an in-context reconnect, a reload
    // gives a FRESH hook: shouldRecoverFromHistory starts false. The server
    // still has the in-flight run and, while it async-fetches chat.history,
    // broadcasts the post-subscribe deltas (the SUFFIX) to the freshly
    // subscribed ws — so " two"/" three" arrive BEFORE the history response,
    // which carries the already-streamed prefix "one" as partialContent.
    //
    // The prefix and suffix never overlap (server's "never both" guarantee), so
    // the resumed reply must be "one two three", not the suffix-only " two three".
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());

    // Post-subscribe deltas arrive first (the new ws missed "one" — it went to
    // the pre-reload connection). Each carries the in-flight message id.
    act(() => ws.simulateMessage({ type: "chunk", messageId: "srv-1", content: " two" }));
    act(() => ws.simulateMessage({ type: "chunk", messageId: "srv-1", content: " three" }));

    // The late history response carries the pre-reload prefix as partialContent.
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "list one..ten" }],
        activeRun: {
          runId: "run-1",
          messageId: "srv-1",
          startedAt: 1000,
          partialContent: "one",
        },
      })
    );

    const msgs = (
      result.current.runtime as { messages?: { id: string; role: string; content?: unknown }[] }
    ).messages!;
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.id).toBe("srv-1");
    // Exactly one bubble carries the run id — no duplicate.
    expect(msgs.filter((m) => m.id === "srv-1")).toHaveLength(1);
    // The prefix must NOT be dropped: full reply is "one two three".
    expect(JSON.stringify(last.content)).toContain("one two three");
  });

  it("does NOT duplicate the reply when the run completes before the late history response (reload race)", () => {
    // The other side of the reload race: the run finishes DURING the history
    // fetch (fast model / short reply / reload in the dispatch→first-chunk
    // window). The new ws buffered the in-flight deltas + a `complete`, but by
    // the time the history response lands the run is gone (no activeRun) and
    // the FULL reply is already persisted in history. Draining the now-stale
    // buffered deltas would append a SECOND, suffix-only assistant bubble next
    // to the persisted one. They must be dropped instead.
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());

    act(() => ws.simulateMessage({ type: "chunk", messageId: "srv-1", content: " two" }));
    act(() => ws.simulateMessage({ type: "chunk", messageId: "srv-1", content: " three" }));
    act(() => ws.simulateMessage({ type: "complete" }));

    // History response: run already completed (no activeRun) and the full reply
    // is persisted.
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "list one..ten" },
          { role: "assistant", content: "one two three" },
        ],
      })
    );

    const msgs = (
      result.current.runtime as { messages?: { id: string; role: string; content?: unknown }[] }
    ).messages!;
    const assistants = msgs.filter((m) => m.role === "assistant");
    // Exactly ONE assistant bubble — no stale duplicate from the dropped buffer.
    expect(assistants).toHaveLength(1);
    expect(JSON.stringify(assistants[0]!.content)).toContain("one two three");
  });

  it("anchors the trailing assistant in place when the reply IS in history", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "list one..ten" },
          { role: "assistant", content: "one two" },
        ],
        activeRun: { runId: "run-1", messageId: "srv-1", startedAt: 1000 },
      })
    );

    const msgs = messagesOf(result.current.runtime);
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.id).toBe("srv-1");
    // Exactly one message carries the run id — no duplicate bubble.
    expect(msgs.filter((m) => m.id === "srv-1")).toHaveLength(1);
  });
});
