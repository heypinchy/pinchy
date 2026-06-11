/**
 * Regression guard for the tab-refocus tapClientLookup crash (v0.5.7 prod).
 *
 * assistant-ui injects an OPTIMISTIC assistant message while
 * `isRunning && last.role !== "assistant"` and removes it on any
 * `isRunning → false` flip — that removal shrinks the rendered count and a
 * stale trailing-index subscriber crashes the view (`tapClientLookup: Index N
 * out of bounds (length: N)`). Two unguarded flips existed: the
 * lifecycle-suspend branch and the #199 grace branch of ws.onclose.
 *
 * The fix kills the class at the source: the send path appends Pinchy's OWN
 * empty in-flight assistant placeholder, so the list always ends in an
 * assistant while running and the optimistic message never exists. These
 * tests pin the proximate invariant (jsdom cannot reproduce the tap-scheduler
 * race itself — see the #470 lesson).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";

vi.mock("@/lib/image-compression", () => ({
  compressImageForChat: vi.fn(async (file: File) => ({ ok: true, file, skipped: true })),
}));
vi.mock("@/lib/upload-attachment", () => ({ uploadAttachment: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
}
vi.stubGlobal("WebSocket", MockWebSocket);

type Converted = {
  id: string;
  role: string;
  content?: unknown;
  metadata?: { custom?: { error?: unknown } };
};

function errorOf(msg: Converted | undefined): unknown {
  return msg?.metadata?.custom?.error;
}
function messagesOf(runtime: unknown): Converted[] {
  return ((runtime as { messages?: Converted[] }).messages ?? []) as Converted[];
}

function sendText(result: { current: { runtime: unknown } }, text: string) {
  (
    result.current.runtime as {
      onNew: (m: { content: { type: string; text: string }[]; parentId: string }) => void;
    }
  ).onNew({ content: [{ type: "text", text }], parentId: "root" });
}

describe("useWsRuntime — in-flight placeholder invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
  });
  afterEach(() => vi.useRealTimers());

  function setup() {
    const hook = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    act(() => ws.simulateOpen());
    return { hook, ws };
  }

  it("sending a message appends the in-flight assistant placeholder (list ends in assistant while running)", () => {
    const { hook } = setup();
    act(() => sendText(hook.result, "hello"));

    expect(hook.result.current.isRunning).toBe(true);
    const msgs = messagesOf(hook.result.current.runtime);
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe("assistant");
  });

  it("the first chunk merges into the placeholder instead of appending a second bubble", () => {
    const { hook, ws } = setup();
    act(() => sendText(hook.result, "hello"));
    const countAfterSend = messagesOf(hook.result.current.runtime).length;

    act(() => ws.simulateMessage({ type: "chunk", messageId: "srv-1", content: "Hi" }));

    const msgs = messagesOf(hook.result.current.runtime);
    expect(msgs.length).toBe(countAfterSend); // adopted, not appended
    expect(msgs[msgs.length - 1]?.id).toBe("srv-1");
  });

  it("CRASH GUARD: ws close before the first chunk keeps the list ending in assistant (count-neutral isRunning flip)", () => {
    // The production sequence: send → tab backgrounded → browser closes the WS
    // → onclose flips isRunning false. Pre-fix, assistant-ui's optimistic
    // message vanished here (rendered count -1 → tapClientLookup). With the
    // placeholder, the flip is count-neutral: the list still ends in assistant.
    const { hook, ws } = setup();
    act(() => sendText(hook.result, "hello"));
    const countBefore = messagesOf(hook.result.current.runtime).length;

    act(() => ws.simulateClose());

    expect(hook.result.current.isRunning).toBe(false);
    const msgs = messagesOf(hook.result.current.runtime);
    expect(msgs.length).toBe(countBefore); // nothing vanished in the flip
    expect(msgs[msgs.length - 1]?.role).toBe("assistant");
  });

  it("the deferred disconnect bubble REPLACES the placeholder instead of appending next to it", () => {
    const { hook, ws } = setup();
    act(() => sendText(hook.result, "hello"));
    const countAfterSend = messagesOf(hook.result.current.runtime).length;

    act(() => ws.simulateClose());
    act(() => {
      vi.advanceTimersByTime(2100); // DISCONNECT_ERROR_GRACE_MS
    });

    const msgs = messagesOf(hook.result.current.runtime);
    expect(msgs.length).toBe(countAfterSend); // bubble took the placeholder's slot
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe("assistant");
    expect(errorOf(last)).toBeTruthy();
  });

  it("the stuck-timeout bubble REPLACES the placeholder instead of appending next to it", () => {
    const { hook } = setup();
    act(() => sendText(hook.result, "hello"));
    const countAfterSend = messagesOf(hook.result.current.runtime).length;

    act(() => {
      vi.advanceTimersByTime(61_000); // STUCK_TIMEOUT_MS
    });

    const msgs = messagesOf(hook.result.current.runtime);
    expect(msgs.length).toBe(countAfterSend);
    expect(errorOf(msgs[msgs.length - 1])).toBeTruthy();
  });
});
