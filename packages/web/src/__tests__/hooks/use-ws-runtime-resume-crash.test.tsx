/**
 * Hook-layer regression guard for the streaming-resume crashes (#470).
 * Reloading the tab mid-stream lands on the `activeRun` resume path:
 * the fresh client fetches history + an activeRun signal and re-attaches to the
 * in-flight run, then chunks stream in. A bug let assistant-ui's MessageRepository
 * end up with the same message id at two positions in the parent chain, which
 * throws ("A message with the same id already exists in the parent tree") and
 * replaces the chat with the app's error boundary ("Something went wrong").
 *
 * Unlike `use-ws-runtime.test.ts` (which mocks @assistant-ui/react to the
 * identity function and so never exercises the repository sync), this test uses
 * the REAL assistant-ui runtime: useWsRuntime feeds its convertedMessages into a
 * real <AssistantRuntimeProvider>/<Thread>, whose repository sync runs in a
 * useEffect on every render. The MessageRepository duplicate-id relink cycle
 * therefore throws here exactly as it does in the browser. (jsdom renders
 * synchronously, so it does NOT reproduce the concurrent-mode tapClientLookup
 * desync — the reload-mid-stream E2E is authoritative for that; the invariant
 * is pinned by use-ws-runtime-active-run-anchor.test.ts.) The error boundary
 * below mirrors app/error.tsx so a crash flips `errored` to true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive } from "@assistant-ui/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";

// --- unrelated dependency mocks (NOT @assistant-ui/react — we want the real one) ---
vi.mock("@/lib/image-compression", () => ({
  compressImageForChat: vi.fn(async (file: File) => ({ ok: true, file, skipped: true })),
}));
vi.mock("@/lib/upload-attachment", () => ({ uploadAttachment: vi.fn() }));
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ isRestarting: false, triggerRestart: vi.fn() }),
}));

let wsInstances: MockWebSocket[] = [];
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
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

function latestWs(): MockWebSocket {
  const ws = wsInstances[wsInstances.length - 1];
  if (!ws) throw new Error("No MockWebSocket instance created yet");
  return ws;
}

// Error boundary mirroring app/error.tsx — flips to the fallback on any throw.
class CrashBoundary extends Component<{ children: ReactNode }, { errored: boolean }> {
  state = { errored: false };
  static getDerivedStateFromError() {
    return { errored: true };
  }
  componentDidCatch() {}
  render() {
    if (this.state.errored) return <div data-testid="crashed">Something went wrong</div>;
    return this.props.children;
  }
}

const ThreadView = () => (
  <ThreadPrimitive.Root>
    <ThreadPrimitive.Viewport>
      <ThreadPrimitive.Messages
        components={{
          UserMessage: () => (
            <div data-role="user">
              <MessagePrimitive.Parts />
            </div>
          ),
          AssistantMessage: () => (
            <div data-role="assistant">
              <MessagePrimitive.Parts />
            </div>
          ),
        }}
      />
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
);

function Harness() {
  const { runtime } = useWsRuntime("agent-1");
  return (
    <CrashBoundary>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadView />
      </AssistantRuntimeProvider>
    </CrashBoundary>
  );
}

describe("useWsRuntime — reload mid-stream resume does not crash assistant-ui", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("A: history[user,assistant]+activeRun then chunks", () => {
    render(<Harness />);
    const ws = latestWs();
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
    act(() => ws.simulateMessage({ type: "chunk", content: " three", messageId: "srv-1" }));
    act(() => ws.simulateMessage({ type: "chunk", content: " ten", messageId: "srv-1" }));
    act(() => ws.simulateMessage({ type: "complete" }));
    expect(screen.queryByTestId("crashed")).toBeNull();
  });

  it("B: history[user]-only +activeRun (optimistic path) then chunks", () => {
    render(<Harness />);
    const ws = latestWs();
    act(() => ws.simulateOpen());
    // In-flight run: the assistant message is not yet persisted, so history
    // returns only the user turn while activeRun points at the live message.
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "list one..ten" }],
        activeRun: { runId: "run-1", messageId: "srv-1", startedAt: 1000 },
      })
    );
    act(() => ws.simulateMessage({ type: "chunk", content: "one two", messageId: "srv-1" }));
    act(() => ws.simulateMessage({ type: "chunk", content: " ten", messageId: "srv-1" }));
    act(() => ws.simulateMessage({ type: "complete" }));
    expect(screen.queryByTestId("crashed")).toBeNull();
  });

  it("C: chunk buffered BEFORE history[user]+activeRun (Tier 2b drain)", () => {
    render(<Harness />);
    const ws = latestWs();
    act(() => ws.simulateOpen());
    // Chunk arrives before the history frame — buffered until reconcile drains it.
    act(() => ws.simulateMessage({ type: "chunk", content: "one two", messageId: "srv-1" }));
    act(() =>
      ws.simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "list one..ten" }],
        activeRun: { runId: "run-1", messageId: "srv-1", startedAt: 1000 },
      })
    );
    act(() => ws.simulateMessage({ type: "chunk", content: " ten", messageId: "srv-1" }));
    act(() => ws.simulateMessage({ type: "complete" }));
    expect(screen.queryByTestId("crashed")).toBeNull();
  });

  it("D: chunk buffered BEFORE history[user,assistant]+activeRun", () => {
    render(<Harness />);
    const ws = latestWs();
    act(() => ws.simulateOpen());
    act(() => ws.simulateMessage({ type: "chunk", content: " three", messageId: "srv-1" }));
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
    act(() => ws.simulateMessage({ type: "chunk", content: " ten", messageId: "srv-1" }));
    act(() => ws.simulateMessage({ type: "complete" }));
    expect(screen.queryByTestId("crashed")).toBeNull();
  });
});
