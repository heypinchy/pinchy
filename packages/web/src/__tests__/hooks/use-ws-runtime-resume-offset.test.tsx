// @vitest-environment jsdom
/**
 * Streaming resume must show every streamed word exactly once.
 *
 * A history frame that carries `activeRun.partialContent` re-seeds the
 * in-flight bubble with the text the server has emitted so far. Chunk frames
 * are deltas, and each one says where in that text it starts (`offset`). Two
 * ways the bubble went wrong before the client read the offset:
 *
 * - Tab refocus on a socket that never dropped. The socket is still one of the
 *   run's listeners, so every word between the history request and the server's
 *   snapshot arrives as a buffered delta AND inside `partialContent`. Draining
 *   the buffer onto the seeded bubble showed those words twice.
 * - Reconnect on a new socket in a chat begun in this tab. The local list
 *   starts with the client-only greeting, so it is longer than the server's
 *   [user] + anchor. The never-shrink guard kept the local list and threw away
 *   `partialContent`; the words streamed during the disconnect stayed missing
 *   until the next reload.
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
  useExternalStoreRuntime: (config: unknown) => config,
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
  simulateClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
  sentTypes(): string[] {
    return this.send.mock.calls.map((c) => (JSON.parse(c[0] as string) as { type: string }).type);
  }
}
vi.stubGlobal("WebSocket", MockWebSocket);

type Converted = {
  id: string;
  role: string;
  content?: Array<{ type: string; text?: string }>;
};
function messagesOf(runtime: unknown): Converted[] {
  return ((runtime as { messages?: Converted[] }).messages ?? []) as Converted[];
}
function textOf(message: Converted | undefined): string {
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}
function sendText(result: { current: { runtime: unknown } }, text: string) {
  (
    result.current.runtime as {
      onNew: (m: { content: { type: string; text: string }[]; parentId: string }) => void;
    }
  ).onNew({ content: [{ type: "text", text }], parentId: "root" });
}
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}
function chunk(content: string, offset: number) {
  return { type: "chunk", messageId: "srv-1", content, offset };
}

describe("useWsRuntime — resume shows each streamed word once", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
    setVisibility("visible");
  });
  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("does not repeat the words that arrive between a refocus history request and the server's snapshot", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());
    // A chat loaded from server history: no client-only greeting at index 0.
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello." },
        ],
      })
    );
    act(() => sendText(result, "count to five"));
    act(() => ws.simulateMessage(chunk("one", 0)));
    act(() => ws.simulateMessage(chunk(" two", 3)));

    // Switch tabs and come back well inside the grace period: the socket stays
    // OPEN and the refocus re-requests history on it.
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(ws.sentTypes().filter((t) => t === "history")).toHaveLength(2);

    // " three" streams while the history is being fetched. This socket is a
    // listener, so it gets the delta — and the snapshot below already holds it.
    act(() => ws.simulateMessage(chunk(" three", 7)));
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello." },
          { role: "user", content: "count to five" },
        ],
        activeRun: {
          runId: "run-1",
          messageId: "srv-1",
          startedAt: 1000,
          partialContent: "one two three",
        },
      })
    );
    act(() => ws.simulateMessage(chunk(" four", 13)));

    const msgs = messagesOf(result.current.runtime);
    expect(msgs.filter((m) => m.id === "srv-1")).toHaveLength(1);
    expect(textOf(msgs.at(-1))).toBe("one two three four");
  });

  it("restores the words streamed during a disconnect in a chat begun in this tab", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = wsInstances[0]!;
    act(() => ws1.simulateOpen());
    // Fresh chat: only the client-only greeting, which the server never persists.
    act(() =>
      ws1.simulateMessage({
        type: "history",
        messages: [{ role: "assistant", content: "Hi, how can I help?" }],
      })
    );
    act(() => sendText(result, "count to five"));
    const sent = JSON.parse(ws1.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };
    act(() => ws1.simulateMessage({ type: "ack", clientMessageId: sent.clientMessageId }));
    act(() => ws1.simulateMessage(chunk("one", 0)));

    // The socket drops; " two three" streams while nobody is listening.
    act(() => {
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);
    });
    const ws2 = wsInstances[1]!;
    act(() => ws2.simulateOpen());
    act(() =>
      ws2.simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "count to five" }],
        activeRun: {
          runId: "run-1",
          messageId: "srv-1",
          startedAt: 1000,
          partialContent: "one two three",
        },
      })
    );
    act(() => ws2.simulateMessage(chunk(" four", 13)));

    const msgs = messagesOf(result.current.runtime);
    // The greeting and the user turn stay; one bubble carries the reply.
    expect(textOf(msgs[0])).toBe("Hi, how can I help?");
    expect(msgs.filter((m) => m.id === "srv-1")).toHaveLength(1);
    expect(textOf(msgs.at(-1))).toBe("one two three four");
  });

  it("keeps the part of a straddling delta that the snapshot does not hold", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "count to five" }],
        activeRun: {
          runId: "run-1",
          messageId: "srv-1",
          startedAt: 1000,
          partialContent: "one tw",
        },
      })
    );
    // A delta that begins inside the seeded text: only "o three" is new.
    act(() => ws.simulateMessage(chunk("two three", 4)));

    expect(textOf(messagesOf(result.current.runtime).at(-1))).toBe("one two three");
  });
});
