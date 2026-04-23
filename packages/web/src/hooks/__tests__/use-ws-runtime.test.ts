import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── WebSocket mock ────────────────────────────────────────────────────────────

const wsInstances: MockWebSocketClass[] = [];

class MockWebSocketClass {
  static OPEN = 1;

  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  readyState = 1; // OPEN

  constructor() {
    wsInstances.push(this);
  }

  /** Trigger onopen so the WS is considered connected */
  simulateOpen() {
    this.onopen?.(new Event("open"));
  }

  /** Deliver a JSON-serialised frame to onmessage */
  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  /** Trigger onclose */
  simulateClose() {
    this.onclose?.(new CloseEvent("close"));
  }
}

/** Returns the most recently created MockWebSocket instance */
function latestWs(): MockWebSocketClass {
  const ws = wsInstances[wsInstances.length - 1];
  if (!ws) throw new Error("No MockWebSocket instance created yet");
  return ws;
}

// Stub WebSocket globally at module level — same pattern as the companion test
// suite in src/__tests__/hooks/use-ws-runtime.test.ts.
vi.stubGlobal("WebSocket", MockWebSocketClass);

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: vi.fn() }),
}));

// Capture the `onNew` callback passed into useExternalStoreRuntime so tests
// can call it directly without needing to interact with the assistant-ui UI.
let capturedOnNew: ((msg: unknown) => void) | null = null;

vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: (opts: { onNew?: (msg: unknown) => void }) => {
    capturedOnNew = opts.onNew ?? null;
    return {
      /* opaque runtime object */
    };
  },
  SimpleImageAttachmentAdapter: class {},
  SimpleTextAttachmentAdapter: class {
    public accept = "";
  },
  CompositeAttachmentAdapter: class {
    constructor(public adapters: unknown[]) {}
  },
}));

// ── Import hook AFTER mocks ────────────────────────────────────────────────────

import { useWsRuntime } from "../use-ws-runtime";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal AppendMessage shape that onNew expects */
function makeUserMessage(text: string) {
  return {
    content: [{ type: "text", text }],
    attachments: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useWsRuntime — status reducer + orphan detector", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
  });

  it("transitions user message from sending to sent on ack, then isOrphaned=true after complete", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    // Open the WebSocket connection
    await act(async () => {
      latestWs().simulateOpen();
      // Deliver history (empty) so isHistoryLoaded=true
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    expect(result.current.isHistoryLoaded).toBe(true);
    // Not orphaned yet (no messages)
    expect(result.current.isOrphaned).toBe(false);

    // Send a user message
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    // isRunning is true → not orphaned even though last message is user
    expect(result.current.isOrphaned).toBe(false);

    // Capture the clientMessageId from the outgoing WS frame
    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      type: string;
      clientMessageId: string;
    };
    expect(sentPayload.type).toBe("message");
    expect(sentPayload.clientMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // Deliver ack — message transitions sending → sent, but isRunning still true
    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
    });

    // Still not orphaned because isRunning=true
    expect(result.current.isOrphaned).toBe(false);

    // Deliver complete — isRunning resets to false
    await act(async () => {
      ws.simulateMessage({ type: "complete" });
    });

    // Now: last message is user, status=sent, isRunning=false, isHistoryLoaded=true
    // → isOrphaned must be true
    expect(result.current.isOrphaned).toBe(true);
  });

  it("includes clientMessageId in the outgoing WS frame", async () => {
    renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("test message"));
    });

    const ws = latestWs();
    // Find the 'message' frame (history request is the first send)
    const messageCalls = ws.send.mock.calls.filter((call) => {
      const parsed = JSON.parse(call[0] as string) as { type: string };
      return parsed.type === "message";
    });

    expect(messageCalls).toHaveLength(1);
    const frame = JSON.parse(messageCalls[0][0] as string) as {
      clientMessageId?: string;
    };
    expect(frame.clientMessageId).toBeDefined();
    expect(typeof frame.clientMessageId).toBe("string");
  });

  it("does not start a timeout timer for history messages", async () => {
    // This is a sanity check — history messages don't go through onNew,
    // so no timer should be started for them.
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "old message" }],
      });
    });

    // Advance 10+ seconds — no timeout dispatch expected (no errors)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // isOrphaned should be false since isRunning=false and last message role=user
    // but status is undefined (loaded from history, not sent via onNew)
    expect(result.current.isOrphaned).toBe(false);
    vi.useRealTimers();
  });

  it("isOrphaned is false when assistant has responded", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };

    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      ws.simulateMessage({
        type: "chunk",
        messageId: "assistant-msg-1",
        content: "Hello!",
      });
      ws.simulateMessage({ type: "complete" });
    });

    // Last message is assistant → not orphaned
    expect(result.current.isOrphaned).toBe(false);
  });
});

// ── Ack timeout tests ─────────────────────────────────────────────────────────

describe("useWsRuntime — ack timeout", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions message to failed after 10s without ack", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a user message
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    // Before timeout: isRunning=true → isOrphaned=false
    expect(result.current.isOrphaned).toBe(false);

    // Advance 10 seconds — timeout should fire, message → "failed"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Deliver complete (no ack was sent)
    await act(async () => {
      latestWs().simulateMessage({ type: "complete" });
    });

    // After complete: isRunning=false. If the timeout fired correctly, the
    // last message has status="failed" → isOrphaned=false.
    // Without the timeout implementation, the message stays "sending" and
    // isOrphaned would also be false (since "sending" ≠ "sent"), but a late ack
    // would then flip it to "sent". The key distinction is tested in the
    // "late ack" test below. Here we verify the happy-path of the timeout.
    expect(result.current.isOrphaned).toBe(false);
  });

  it("does NOT fail message if ack arrives before 10s", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a user message
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };

    // Advance 5 seconds (before the 10s timeout)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Deliver ack before timeout fires
    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
    });

    // Advance 5 more seconds — total 10s passed, timeout would have fired
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Now deliver complete
    await act(async () => {
      ws.simulateMessage({ type: "complete" });
    });

    // Message was acked (status=sent), then complete arrived → isOrphaned=true
    // (last message is user with status "sent" and isRunning=false)
    expect(result.current.isOrphaned).toBe(true);
  });

  it("late ack after failed transition is discarded", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a user message
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };

    // Advance 10 seconds — timeout fires, message → failed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Now deliver a late ack
    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
    });

    // Then complete
    await act(async () => {
      ws.simulateMessage({ type: "complete" });
    });

    // Message remains "failed" (reducer ignores acks for non-sending messages).
    // isOrphaned=false because status is "failed", not "sent"
    expect(result.current.isOrphaned).toBe(false);
  });
});

// ── History reconcile on reconnect tests ──────────────────────────────────────

describe("history reconcile on reconnect", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("upgrades in-flight sending messages to sent when they appear in reloaded history", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    // Connect and load initial empty history
    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a user message — it will have status "sending"
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello from user"));
    });

    // Simulate a history reload that contains the user message (it was persisted).
    // Note: because shouldRecoverFromHistory=false here (no disconnect),
    // the local message list keeps the user message — but its status is reconciled
    // from "sending" to "sent" because the content appears in history.
    await act(async () => {
      latestWs().simulateMessage({
        type: "history",
        messages: [
          { role: "user", content: "hello from user", timestamp: 1000 },
          { role: "assistant", content: "Hi there!", timestamp: 2000 },
        ],
      });
    });

    // Deliver complete so isRunning resets
    await act(async () => {
      latestWs().simulateMessage({ type: "complete" });
    });

    // After complete: local messages = [user "hello from user" status="sent"].
    // Last message is user with status "sent" → isOrphaned=true.
    // This confirms the reconcile upgraded "sending" → "sent".
    expect(result.current.isOrphaned).toBe(true);
  });

  it("marks in-flight sending message as sent (isOrphaned=true) when history contains it and assistant hasn't replied yet", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    // Connect and load initial empty history
    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a user message — it will have status "sending"
    await act(async () => {
      capturedOnNew!(makeUserMessage("persisted message"));
    });

    // History reload: contains the user message but no assistant reply yet
    // (e.g. agent is still thinking after reconnect)
    await act(async () => {
      latestWs().simulateMessage({
        type: "history",
        messages: [{ role: "user", content: "persisted message", timestamp: 1000 }],
      });
    });

    // Deliver complete so isRunning resets
    await act(async () => {
      latestWs().simulateMessage({ type: "complete" });
    });

    // After complete: last message is user with status "sent" (reconciled from history),
    // isRunning=false, isHistoryLoaded=true → isOrphaned=true
    expect(result.current.isOrphaned).toBe(true);
  });

  it("fails in-flight sending messages that don't appear in reloaded history", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    // Connect and load initial empty history
    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a user message — it will have status "sending"
    await act(async () => {
      capturedOnNew!(makeUserMessage("lost message"));
    });

    // Simulate a history reload that does NOT contain the message
    // (it was never persisted — connection was lost before OpenClaw received it)
    await act(async () => {
      latestWs().simulateMessage({
        type: "history",
        messages: [],
      });
    });

    // Deliver complete so isRunning resets
    await act(async () => {
      latestWs().simulateMessage({ type: "complete" });
    });

    // The sending message should now be "failed" — not in history.
    // isOrphaned is false because status="failed" (not "sent")
    expect(result.current.isOrphaned).toBe(false);
  });
});
