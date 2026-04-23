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
