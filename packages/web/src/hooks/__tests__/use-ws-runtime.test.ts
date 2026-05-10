/**
 * Test suite for useWsRuntime — callback API + status-reducer flow.
 *
 * NOTE: A SECOND companion suite lives at
 *   packages/web/src/__tests__/hooks/use-ws-runtime.test.ts
 *
 * That file uses a different mocking strategy (real WebSocket via
 * `vi.stubGlobal` + accessing `result.current.runtime.onNew`) and focuses
 * on system aspects (reconnect/backoff, agent switching, history reload,
 * delay/stuck timers, 1009 frame-too-large handling). When you add a new
 * module mock here, mirror it there — both files have to stay in sync.
 *
 * Tracking issue for full consolidation: #313.
 */
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

// Mock image compression — real Canvas API is unavailable in jsdom.
// Returns the new CompressionResult shape (ok=true, skipped=true).
vi.mock("@/lib/image-compression", () => ({
  compressImageForChat: vi.fn(async (file: File) => ({
    ok: true,
    file,
    skipped: true,
  })),
}));

vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: vi.fn() }),
}));

// Capture the `onNew` callback and `messages` passed into useExternalStoreRuntime
// so tests can call it directly without needing to interact with the assistant-ui UI.
// onNew is async (runs image compression), so type it as returning Promise<void>.
let capturedOnNew: ((msg: unknown) => Promise<void> | void) | null = null;
let capturedMessages: unknown[] = [];

vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: (opts: {
    onNew?: (msg: unknown) => Promise<void> | void;
    messages?: unknown[];
  }) => {
    capturedOnNew = opts.onNew ?? null;
    capturedMessages = opts.messages ?? [];
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
import { CLIENT_MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/limits";

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
    capturedMessages = [];
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

  it("exposes synthetic orphan error bubble when isOrphaned is true", async () => {
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
      ws.simulateMessage({ type: "complete" });
    });

    // isOrphaned=true: last message is sent user, agent is idle, history loaded
    expect(result.current.isOrphaned).toBe(true);

    // The synthetic orphan bubble must be appended to the thread messages
    const lastMsg = capturedMessages[capturedMessages.length - 1] as {
      role: string;
      id: string;
      content: Array<{ type: string; text: string }>;
      metadata?: {
        custom?: { syntheticOrphanError?: boolean; retryable?: boolean; retryReason?: string };
      };
    };
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.content).toEqual([{ type: "text", text: "The agent didn't respond." }]);
    expect(lastMsg.metadata?.custom?.syntheticOrphanError).toBe(true);
    expect(lastMsg.metadata?.custom?.retryable).toBe(true);
    expect(lastMsg.metadata?.custom?.retryReason).toBe("orphan");
  });

  it("synthetic orphan bubble disappears when isRunning becomes true", async () => {
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
      ws.simulateMessage({ type: "complete" });
    });

    // Now orphaned
    expect(result.current.isOrphaned).toBe(true);

    // Send a new message — isRunning becomes true → orphan disappears
    await act(async () => {
      capturedOnNew!(makeUserMessage("retry"));
    });

    expect(result.current.isOrphaned).toBe(false);
    // No synthetic bubble in thread messages
    const hasSyntheticBubble = capturedMessages.some((m) => {
      const msg = m as { metadata?: { custom?: { syntheticOrphanError?: boolean } } };
      return msg.metadata?.custom?.syntheticOrphanError === true;
    });
    expect(hasSyntheticBubble).toBe(false);
  });
});

// ── Ack timeout tests ─────────────────────────────────────────────────────────

describe("useWsRuntime — ack timeout", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
    capturedMessages = [];
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

// ── isRunning terminal-path guarantee tests ───────────────────────────────────

describe("isRunning resets to false after every terminal path", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
    capturedMessages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets after assistant stream completes (complete frame)", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    expect(result.current.isRunning).toBe(true);

    await act(async () => {
      latestWs().simulateMessage({ type: "chunk", messageId: "m1", content: "Hi!" });
      latestWs().simulateMessage({ type: "complete" });
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.isDelayed).toBe(false);
  });

  it("resets after assistant stream errors (error WS frame)", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    expect(result.current.isRunning).toBe(true);

    // Simulate an error frame from the server
    await act(async () => {
      latestWs().simulateMessage({ type: "error", message: "Something went wrong" });
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.isDelayed).toBe(false);
  });

  it("resets after WebSocket disconnects mid-stream", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    // Simulate chunk arriving (stream started), then WS closes
    await act(async () => {
      latestWs().simulateMessage({ type: "chunk", messageId: "m1", content: "Partial..." });
    });

    expect(result.current.isRunning).toBe(true);

    // Now disconnect mid-stream — onclose fires
    await act(async () => {
      latestWs().simulateClose();
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.isDelayed).toBe(false);
  });

  it("resets after 60s stuck timeout with no activity", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    expect(result.current.isRunning).toBe(true);

    // Advance 60 seconds — stuck timer fires, isRunning must reset
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.isDelayed).toBe(false);
  });

  it("does NOT reset isRunning on 10s ack timeout — stuck timer (60s) is the safety valve", async () => {
    // The 10s ack timeout governs message DELIVERY status only — it marks the
    // user message as "failed" if OpenClaw never sent an ack. But isRunning is
    // intentionally kept true until a real terminal event (complete / error /
    // disconnect / 60s stuck timeout). This keeps the spinner showing so the
    // user knows the agent might still be working (e.g. OpenClaw received the
    // message but the ack frame was dropped). The 60s stuck timer is the
    // unconditional safety valve that resets isRunning if truly nothing happens.
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    expect(result.current.isRunning).toBe(true);

    // Advance 10 seconds — ack timeout fires, message → failed
    // The WebSocket stays connected (no simulateClose)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // isRunning is still true — ack timeout only affects delivery status, not running state
    expect(result.current.isRunning).toBe(true);

    // Advance to 60 seconds — stuck timer fires, now isRunning resets
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000);
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.isDelayed).toBe(false);
  });
});

// ── retryable flag on injected error bubbles ──────────────────────────────────

describe("injected error bubbles have retryable: true", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
    capturedMessages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disconnect error bubble has retryReason 'send_failure' when no chunks were received", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    // WS dies BEFORE any chunk arrives — no last turn to continue, must resend.
    await act(async () => {
      latestWs().simulateClose();
    });

    expect(result.current.isRunning).toBe(false);

    const lastMsg = capturedMessages[capturedMessages.length - 1] as {
      role: string;
      metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
    };
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.metadata?.custom?.retryable).toBe(true);
    expect(lastMsg.metadata?.custom?.retryReason).toBe("send_failure");
  });

  it("disconnect error bubble has retryable: true in metadata", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    // Start a stream (chunk arrives) then WS disconnects
    await act(async () => {
      latestWs().simulateMessage({ type: "chunk", messageId: "m1", content: "Partial..." });
    });

    await act(async () => {
      latestWs().simulateClose();
    });

    // isRunning should have been true, so a disconnect error bubble was injected
    expect(result.current.isRunning).toBe(false);

    const lastMsg = capturedMessages[capturedMessages.length - 1] as {
      role: string;
      metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
    };
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.metadata?.custom?.retryable).toBe(true);
    expect(lastMsg.metadata?.custom?.retryReason).toBe("partial_stream_failure");
  });

  it("stuck timeout error bubble has retryable: true in metadata", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    expect(result.current.isRunning).toBe(true);

    // Advance 60 seconds — stuck timer fires
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.isRunning).toBe(false);

    const lastMsg = capturedMessages[capturedMessages.length - 1] as {
      role: string;
      metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
    };
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.metadata?.custom?.retryable).toBe(true);
    expect(lastMsg.metadata?.custom?.retryReason).toBe("partial_stream_failure");
  });

  it("error WS frame bubble has retryReason 'send_failure' when no chunks were received", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    expect(result.current.isRunning).toBe(true);

    // Error arrives BEFORE any assistant chunks — there is no "last turn" to
    // continue, so retry must resend the original message instead.
    await act(async () => {
      latestWs().simulateMessage({ type: "error", message: "Something went wrong" });
    });

    expect(result.current.isRunning).toBe(false);

    const lastMsg = capturedMessages[capturedMessages.length - 1] as {
      role: string;
      metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
    };
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.metadata?.custom?.retryable).toBe(true);
    expect(lastMsg.metadata?.custom?.retryReason).toBe("send_failure");
  });

  it("does not wipe completed conversation on reconnect when server returns empty history", async () => {
    // Common case: OpenClaw is down. Browser reconnects to Pinchy, requests
    // history, server can't reach OpenClaw → returns empty. We must keep what
    // the user already has on screen instead of replacing with empty.
    renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Build a completed turn: user → ack → assistant chunk → complete
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });
    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };
    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      ws.simulateMessage({ type: "chunk", messageId: "asst-1", content: "Hi there!" });
      ws.simulateMessage({ type: "complete" });
    });

    const beforeDisconnect = (capturedMessages as Array<{ role: string }>).length;
    expect(beforeDisconnect).toBeGreaterThanOrEqual(2);

    // Disconnect (no stream in progress, no error bubble injected)
    await act(async () => {
      ws.simulateClose();
    });

    // Reconnect with empty history (because upstream OpenClaw is unreachable)
    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Messages from before the disconnect must still be present
    const userMessages = (capturedMessages as Array<{ role: string }>).filter(
      (m) => m.role === "user"
    );
    expect(userMessages).toHaveLength(1);
    const assistantMessages = (capturedMessages as Array<{ role: string }>).filter(
      (m) => m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("does not wipe local state on reconnect when last message is the disconnect error bubble", async () => {
    renderHook(() => useWsRuntime("agent-1"));

    // Open WS, load empty history
    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a message and receive a partial chunk
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };
    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      ws.simulateMessage({ type: "chunk", messageId: "asst-1", content: "Partial " });
    });

    // Simulate disconnect — adds the "Connection lost" error bubble + arms reconcile
    await act(async () => {
      ws.simulateClose();
    });

    const beforeReconnect = (capturedMessages as Array<{ role: string }>).length;
    expect(beforeReconnect).toBeGreaterThanOrEqual(3); // user + partial assistant + error

    // Reconnect: new WS opens, server returns the same empty history
    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Local state must be preserved — empty server history can't be canonical
    // when we still have unpersisted local state ending in an error bubble.
    const errorBubbles = (
      capturedMessages as Array<{ role: string; metadata?: { custom?: { error?: unknown } } }>
    ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorBubbles).toHaveLength(1);

    // The user message must still be there
    const userMessages = (capturedMessages as Array<{ role: string }>).filter(
      (m) => m.role === "user"
    );
    expect(userMessages).toHaveLength(1);
  });

  it("removes the previous partial assistant response when the retry's first chunk arrives", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("write a story"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };

    // First turn: ack + partial chunk + error (interrupted mid-stream)
    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      ws.simulateMessage({ type: "chunk", messageId: "asst-old", content: "Once upon a time…" });
      ws.simulateMessage({ type: "error", message: "Stream broken" });
    });

    // Pre-retry: 2 assistant entries (partial + error bubble)
    expect(
      (capturedMessages as Array<{ role: string }>).filter((m) => m.role === "assistant")
    ).toHaveLength(2);

    await act(async () => {
      result.current.onRetryContinue("partial_stream_failure");
    });
    await act(async () => {
      ws.simulateMessage({ type: "chunk", messageId: "asst-new", content: "Once upon" });
    });

    // After the retry's first chunk: only user + new assistant remain.
    // The previous partial response and the error bubble are both gone.
    const finalMessages = capturedMessages as Array<{ role: string }>;
    expect(finalMessages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(finalMessages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("error bubble is auto-dismissed when a successful chunk arrives", async () => {
    renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    const ws = latestWs();
    await act(async () => {
      ws.simulateMessage({ type: "error", message: "Agent runtime not available" });
    });

    // Confirm the error bubble exists at this point
    const beforeRetry = (
      capturedMessages as Array<{ role: string; metadata?: { custom?: { error?: unknown } } }>
    ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(beforeRetry).toHaveLength(1);

    // Simulate a successful retry: chunk arrives
    await act(async () => {
      ws.simulateMessage({ type: "chunk", messageId: "asst-success", content: "Hello!" });
    });

    // Error bubble must be gone — only the successful assistant chunk remains
    const afterChunk = (
      capturedMessages as Array<{ role: string; metadata?: { custom?: { error?: unknown } } }>
    ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(afterChunk).toHaveLength(0);
  });

  it("a new error bubble replaces the previous one — no stacking", async () => {
    renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    const ws = latestWs();
    await act(async () => {
      ws.simulateMessage({ type: "error", message: "First error" });
    });

    // After first error: 1 user message + 1 error bubble = 2 messages
    const errorBubblesAfterFirst = (
      capturedMessages as Array<{
        role: string;
        metadata?: { custom?: { error?: unknown } };
      }>
    ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorBubblesAfterFirst).toHaveLength(1);

    // Simulate another send + error (e.g. user retried, server failed again)
    await act(async () => {
      capturedOnNew!(makeUserMessage("retry attempt"));
    });
    await act(async () => {
      ws.simulateMessage({ type: "error", message: "Second error" });
    });

    // Only ONE error bubble must exist — the new one replaced the old one
    const errorBubblesAfterSecond = (
      capturedMessages as Array<{
        role: string;
        metadata?: { custom?: { error?: { message?: string } } };
      }>
    ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorBubblesAfterSecond).toHaveLength(1);
    expect(errorBubblesAfterSecond[0].metadata?.custom?.error?.message).toBe("Second error");
  });

  it("error WS frame bubble has retryReason 'partial_stream_failure' when chunks were received", async () => {
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
      ws.simulateMessage({ type: "chunk", messageId: "asst-1", content: "Partial " });
    });

    // Error arrives AFTER a chunk — partial turn was already streamed, so the
    // error gets classified as partial_stream_failure (retryable via resend).
    await act(async () => {
      ws.simulateMessage({ type: "error", message: "Stream broken" });
    });

    expect(result.current.isRunning).toBe(false);

    const lastMsg = capturedMessages[capturedMessages.length - 1] as {
      role: string;
      metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
    };
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.metadata?.custom?.retryable).toBe(true);
    expect(lastMsg.metadata?.custom?.retryReason).toBe("partial_stream_failure");
  });
});

// ── openclaw_status tests ─────────────────────────────────────────────────────

describe("openclaw_status frame", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
    capturedMessages = [];
  });

  it("defaults isOpenClawConnected to false until the server confirms readiness (issue #198)", () => {
    // Green must be earned, not assumed. During the OpenClaw cold-start window
    // after a fresh deploy, the server hasn't yet reported upstream status, so
    // the indicator must stay red rather than lying with green.
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    expect(result.current.isOpenClawConnected).toBe(false);
  });

  it("flips isOpenClawConnected to true on openclaw_status: true frame", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "openclaw_status", connected: true });
    });

    expect(result.current.isOpenClawConnected).toBe(true);
  });

  it("flips isOpenClawConnected back to false on openclaw_status: false frame after a green confirmation", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "openclaw_status", connected: true });
      latestWs().simulateMessage({ type: "openclaw_status", connected: false });
    });

    expect(result.current.isOpenClawConnected).toBe(false);
  });
});

// ── onRetryContinue tests ─────────────────────────────────────────────────────

describe("onRetryContinue", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
    capturedMessages = [];
  });

  // All retry reasons go through the resend path. The Gateway requires a
  // non-empty `message` on every agent request, so there's no protocol-level
  // "continue from session history" mode — resending the user's last message
  // is the canonical retry. The reason is threaded through the frame so the
  // audit log distinguishes orphan / partial_stream_failure / send_failure.

  it("retrying a 'send_failure' resends the original user message with retryReason", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-42"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello world"));
    });

    const ws = latestWs();
    const originalSend = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      content: string;
      clientMessageId: string;
    };

    await act(async () => {
      ws.simulateMessage({ type: "error", message: "Agent runtime not available" });
    });

    await act(async () => {
      result.current.onRetryContinue("send_failure");
    });

    const messageFrames = ws.send.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === "message");
    expect(messageFrames).toHaveLength(2);
    expect(messageFrames[1].content).toBe("hello world");
    expect(messageFrames[1].clientMessageId).toBe(originalSend.clientMessageId);
    expect(messageFrames[1].isRetry).toBe(true);
    expect(messageFrames[1].retryReason).toBe("send_failure");
  });

  it("retrying a 'partial_stream_failure' resends the original user message with retryReason", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-42"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("write a story"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };

    // Receive a chunk so the next error gets classified as partial_stream_failure.
    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      ws.simulateMessage({ type: "chunk", messageId: "asst-1", content: "Once upon..." });
      ws.simulateMessage({ type: "error", message: "Stream broken" });
    });

    await act(async () => {
      result.current.onRetryContinue("partial_stream_failure");
    });

    const messageFrames = ws.send.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === "message");
    expect(messageFrames).toHaveLength(2);
    expect(messageFrames[1].content).toBe("write a story");
    expect(messageFrames[1].isRetry).toBe(true);
    expect(messageFrames[1].retryReason).toBe("partial_stream_failure");
  });

  it("retrying an 'orphan' resends the original user message with retryReason", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-42"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("are you there?"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };

    await act(async () => {
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      ws.simulateMessage({ type: "complete" });
    });

    await act(async () => {
      result.current.onRetryContinue("orphan");
    });

    const messageFrames = ws.send.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === "message");
    expect(messageFrames).toHaveLength(2);
    expect(messageFrames[1].content).toBe("are you there?");
    expect(messageFrames[1].isRetry).toBe(true);
    expect(messageFrames[1].retryReason).toBe("orphan");
  });

  it("sets isRunning to true when called (with a user message present)", async () => {
    const { result } = renderHook(() => useWsRuntime("agent-42"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // The retry path resends the last user message, so a message must exist.
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello"));
    });

    // isRunning is true after sending; let it settle by completing the turn
    await act(async () => {
      const ws = latestWs();
      const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
        clientMessageId: string;
      };
      ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      ws.simulateMessage({ type: "complete" });
    });

    expect(result.current.isRunning).toBe(false);

    await act(async () => {
      result.current.onRetryContinue("partial_stream_failure");
    });

    expect(result.current.isRunning).toBe(true);
  });
});

// ── onRetryResend tests ───────────────────────────────────────────────────────

describe("onRetryResend", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
    capturedMessages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips failed message status to sending and re-sends the WS frame", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a user message
    await act(async () => {
      capturedOnNew!(makeUserMessage("hello retry"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      type: string;
      clientMessageId: string;
      content: string;
    };
    expect(sentPayload.type).toBe("message");
    const messageId = sentPayload.clientMessageId;

    // Advance 10s — timeout fires, message transitions to "failed"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Verify message is now "failed" by checking that no ack timer is registered
    // (the status in the thread message metadata should be "failed")
    const failedMsg = capturedMessages.find((m) => {
      const msg = m as { id?: string; metadata?: { custom?: { status?: string } } };
      return msg.id === messageId && msg.metadata?.custom?.status === "failed";
    });
    expect(failedMsg).toBeDefined();

    // Clear send call history so we can assert the retry re-send
    ws.send.mockClear();

    // Call onRetryResend — should flip status back to "sending" and re-send
    await act(async () => {
      result.current.onRetryResend(messageId);
    });

    // Message status should now be "sending" again
    const retriedMsg = capturedMessages.find((m) => {
      const msg = m as { id?: string; metadata?: { custom?: { status?: string } } };
      return msg.id === messageId && msg.metadata?.custom?.status === "sending";
    });
    expect(retriedMsg).toBeDefined();

    // WS send was called again with the SAME clientMessageId and content
    const retryCalls = ws.send.mock.calls.filter((call) => {
      const parsed = JSON.parse(call[0] as string) as { type: string };
      return parsed.type === "message";
    });
    expect(retryCalls).toHaveLength(1);
    const retryFrame = JSON.parse(retryCalls[0][0] as string) as {
      type: string;
      clientMessageId: string;
      content: string;
      agentId: string;
    };
    expect(retryFrame.clientMessageId).toBe(messageId);
    expect(retryFrame.content).toBe("hello retry");
    expect(retryFrame.agentId).toBe("agent-1");
  });

  it("does nothing if message is not in failed state", async () => {
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

    // Message is still "sending" (no timeout yet) — retry should be a no-op
    ws.send.mockClear();

    await act(async () => {
      result.current.onRetryResend(sentPayload.clientMessageId);
    });

    // No additional WS send for a "message" frame
    const messageSends = ws.send.mock.calls.filter((call) => {
      const parsed = JSON.parse(call[0] as string) as { type: string };
      return parsed.type === "message";
    });
    expect(messageSends).toHaveLength(0);
  });

  it("sets isRunning to true immediately after retry", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("hello retry running"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };
    const messageId = sentPayload.clientMessageId;

    // Advance 10s — timeout fires, message transitions to "failed"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // At this point isRunning is still true (ack timeout doesn't reset it)
    // Advance to 60s so stuck timer resets isRunning to false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000);
    });

    expect(result.current.isRunning).toBe(false);

    // Call onRetryResend — should set isRunning back to true
    await act(async () => {
      result.current.onRetryResend(messageId);
    });

    expect(result.current.isRunning).toBe(true);
  });

  it("preserves image attachments when retrying a failed message", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    // Send a message with an image attachment.
    // Use valid base64 ("YWJj" encodes "abc") so dataUrlToFile parses it correctly.
    // Await capturedOnNew because onNew is now async (it runs image compression).
    const imageDataUrl = "data:image/png;base64,YWJj";
    await act(async () => {
      await capturedOnNew!({
        content: [{ type: "text", text: "look at this image" }],
        attachments: [
          {
            type: "image",
            content: [{ type: "image", image: imageDataUrl }],
          },
        ],
      });
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };
    const messageId = sentPayload.clientMessageId;

    // Advance 10s — timeout fires, message transitions to "failed"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Clear send call history so we can assert the retry re-send
    ws.send.mockClear();

    // Call onRetryResend
    await act(async () => {
      result.current.onRetryResend(messageId);
    });

    // The retry WS frame must include the image in content
    const retryCalls = ws.send.mock.calls.filter((call) => {
      const parsed = JSON.parse(call[0] as string) as { type: string };
      return parsed.type === "message";
    });
    expect(retryCalls).toHaveLength(1);
    const retryFrame = JSON.parse(retryCalls[0][0] as string) as {
      type: string;
      clientMessageId: string;
      content: unknown;
    };
    expect(retryFrame.clientMessageId).toBe(messageId);
    // Content must be a structured array including the image_url part
    expect(Array.isArray(retryFrame.content)).toBe(true);
    const contentArr = retryFrame.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    const textPart = contentArr.find((p) => p.type === "text");
    const imagePart = contentArr.find((p) => p.type === "image_url");
    expect(textPart?.text).toBe("look at this image");
    expect(imagePart?.image_url?.url).toBe(imageDataUrl);
  });

  it("restarts the 10s ack timer after retry", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      latestWs().simulateOpen();
      latestWs().simulateMessage({ type: "history", messages: [] });
    });

    await act(async () => {
      capturedOnNew!(makeUserMessage("timer test"));
    });

    const ws = latestWs();
    const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
      clientMessageId: string;
    };
    const messageId = sentPayload.clientMessageId;

    // Advance 10s — first timeout fires
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Retry the message
    await act(async () => {
      result.current.onRetryResend(messageId);
    });

    // Message is now "sending" again — advance another 10s to fire the new timer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // After second timeout: message should be "failed" again
    const failedMsg = capturedMessages.find((m) => {
      const msg = m as { id?: string; metadata?: { custom?: { status?: string } } };
      return msg.id === messageId && msg.metadata?.custom?.status === "failed";
    });
    expect(failedMsg).toBeDefined();
  });
});

// ── History reconcile on reconnect tests ──────────────────────────────────────

describe("history reconcile on reconnect", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    capturedOnNew = null;
    capturedMessages = [];
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

  describe("binary file attachments (PDF)", () => {
    beforeEach(async () => {
      wsInstances.length = 0;
      capturedOnNew = null;
      capturedMessages = [];
      renderHook(() => useWsRuntime("agent-1"));
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });
    });

    it("includes PDF attachment as image_url content part with filename in WS payload", async () => {
      const pdfBase64 = "YWJj";
      await act(async () => {
        await capturedOnNew!({
          content: [{ type: "text", text: "see this PDF" }],
          attachments: [
            {
              type: "file",
              name: "document.pdf",
              // file carries the size for the pre-send size check
              file: { size: 100 } as unknown as File,
              content: [{ type: "file", data: pdfBase64, mimeType: "application/pdf" }],
            },
          ],
        });
      });

      const ws = latestWs();
      const messageCalls = ws.send.mock.calls.filter((call) => {
        const parsed = JSON.parse(call[0] as string) as { type: string };
        return parsed.type === "message";
      });
      expect(messageCalls).toHaveLength(1);
      const frame = JSON.parse(messageCalls[0][0] as string) as {
        content: unknown;
        filenames?: string[];
      };

      // Content must include an image_url part with the reconstructed data URL
      expect(Array.isArray(frame.content)).toBe(true);
      const contentArr = frame.content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const filePart = contentArr.find((p) => p.type === "image_url");
      expect(filePart?.image_url?.url).toBe(`data:application/pdf;base64,${pdfBase64}`);

      // Filenames must be passed alongside the content
      expect(frame.filenames).toEqual(["document.pdf"]);
    });

    it("shows payloadTooLarge error and does not send WS message when binary file exceeds size limit", async () => {
      await act(async () => {
        await capturedOnNew!({
          content: [{ type: "text", text: "big file" }],
          attachments: [
            {
              type: "file",
              name: "huge.pdf",
              // file.size drives the pre-send size check in onNew
              file: { size: CLIENT_MAX_ATTACHMENT_SIZE_BYTES + 1 } as unknown as File,
              content: [{ type: "file", data: "YWJj", mimeType: "application/pdf" }],
            },
          ],
        });
      });

      const ws = latestWs();
      const messageCalls = ws.send.mock.calls.filter((call) => {
        const parsed = JSON.parse(call[0] as string) as { type: string };
        return parsed.type === "message";
      });
      // No message frame should be sent
      expect(messageCalls).toHaveLength(0);

      // A payloadTooLarge error bubble must appear in the thread
      const errorMsg = (
        capturedMessages as Array<{
          role: string;
          metadata?: { custom?: { error?: { payloadTooLarge?: boolean } } };
        }>
      ).find((m) => m.role === "assistant" && m.metadata?.custom?.error?.payloadTooLarge);
      expect(errorMsg).toBeDefined();
    });
  });
});
