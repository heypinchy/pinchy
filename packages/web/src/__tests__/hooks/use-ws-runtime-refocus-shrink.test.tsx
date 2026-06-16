/**
 * Regression guard for the tab-refocus tapClientLookup crash (#510) that survived
 * BOTH prior fixes (v0.5.7 anchor, v0.5.8 in-flight placeholder).
 *
 * Root cause: assistant-ui renders `thread.messages.length` message components,
 * KEYED BY INDEX, and each child reads `aui.thread().message({ index }).getState()`
 * — i.e. `tapClientLookup.get({ index })`, which throws
 * `tapClientLookup: Index N out of bounds (length: N)` when its index is >= the
 * current resource-list length. So ANY reduction of `messages.length` while
 * <ThreadPrimitive.Messages> is mounted can crash: a trailing-index child
 * re-renders (via its own store subscription) before the parent drops it.
 *
 * The destructive history reconcile is supposed to run behind the
 * `isReconcilingMessages` unmount gate (stageDestructiveHistoryReconcile). But
 * that staging is SKIPPED whenever an `activeRun` signal is present
 * (`!activeRun` in the `shouldStageReplace` predicate). On a tab refocus mid-run
 * the server can legitimately return a history SHORTER than the rich local list
 * (the in-flight reply isn't persisted yet, or OpenClaw history is transiently
 * empty during a restart — see client-router.ts handleHistory, the
 * `messages: [], sessionKnown: true, activeRun` branch). With activeRun present
 * the staged path is bypassed, so the shorter history is applied SYNCHRONOUSLY
 * and `messages.length` shrinks while the thread is mounted → tapClientLookup.
 *
 * jsdom renders synchronously and so does NOT reproduce the concurrent-mode
 * tapClientLookup throw itself (the real-browser e2e is authoritative for that —
 * see use-ws-runtime-resume-crash.test.tsx). These tests pin the proximate,
 * deterministic invariant instead: a refocus/recovery reconcile must NEVER
 * reduce the rendered message count outside the unmount gate.
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
}
vi.stubGlobal("WebSocket", MockWebSocket);

type Converted = { id: string; role: string };
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

describe("useWsRuntime — tab-refocus reconcile must not shrink the message list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("empty recovery history + activeRun must not drop the in-flight conversation (crash precondition)", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = wsInstances[0]!;
    act(() => ws1.simulateOpen());

    // Established conversation, then a new turn that is mid-stream.
    act(() =>
      ws1.simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "A" },
        ],
      })
    );
    act(() => sendText(result, "question")); // appends user + in-flight placeholder
    act(() => ws1.simulateMessage({ type: "chunk", messageId: "srv-1", content: "answer so far" })); // placeholder adopts srv-1

    const before = messagesOf(result.current.runtime).length;
    expect(before).toBe(4);
    expect(result.current.isRunning).toBe(true);

    // Tab backgrounded → ws drops → reconnect → recovery history request.
    act(() => {
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);
    });
    const ws2 = wsInstances[1]!;
    act(() => ws2.simulateOpen());

    // OpenClaw history is transiently empty during the run (restart race); the
    // server still signals the in-flight run. client-router.ts emits exactly
    // this frame: { messages: [], sessionKnown: true, activeRun }.
    act(() =>
      ws2.simulateMessage({
        type: "history",
        messages: [],
        sessionKnown: true,
        activeRun: {
          runId: "run-1",
          messageId: "srv-1",
          startedAt: 1000,
          partialContent: "answer so far",
        },
      })
    );

    const after = messagesOf(result.current.runtime).length;
    // The refocus must NOT reduce the rendered count: a shorter list applied
    // while the thread is mounted (isReconcilingMessages stays false here) is the
    // tapClientLookup crash precondition. Current code shrinks 4 → 1.
    expect(result.current.isReconcilingMessages).toBe(false);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(result.current.isRunning).toBe(true);
  });

  it("shorter (non-empty) recovery history + activeRun must not drop locally-known turns", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = wsInstances[0]!;
    act(() => ws1.simulateOpen());

    act(() =>
      ws1.simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "A" },
        ],
      })
    );
    act(() => sendText(result, "question"));
    act(() => ws1.simulateMessage({ type: "chunk", messageId: "srv-1", content: "answer so far" }));

    const before = messagesOf(result.current.runtime).length;
    expect(before).toBe(4);

    // Refocus: server history lags behind local — the latest turn (user
    // "question" + its in-flight reply) is not persisted yet, so history only
    // carries the older turn, while activeRun points at the live message.
    act(() => {
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);
    });
    const ws2 = wsInstances[1]!;
    act(() => ws2.simulateOpen());
    act(() =>
      ws2.simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "A" },
        ],
        activeRun: {
          runId: "run-1",
          messageId: "srv-1",
          startedAt: 1000,
          partialContent: "answer so far",
        },
      })
    );

    const after = messagesOf(result.current.runtime).length;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
