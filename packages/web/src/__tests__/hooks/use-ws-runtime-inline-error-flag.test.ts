/**
 * #583: the runtime must report whether the thread currently shows an inline
 * error bubble, so the durable paused-error banner can suppress itself and act
 * as a true fallback (rather than rendering the same failure twice after a
 * nav-away/back). This is the single source of truth the banner reads via
 * `useChatSessionHasInlineError`.
 *
 * Mocks @assistant-ui/react to the identity function so the hook's return
 * values are observable directly without a real runtime.
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
}
vi.stubGlobal("WebSocket", MockWebSocket);

describe("useWsRuntime — hasInlineError flag (#583)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsInstances = [];
  });
  afterEach(() => vi.useRealTimers());

  // The client buffers non-history frames until the history response drains
  // the Tier 2b buffer, so every test completes the handshake with an (empty)
  // history frame before driving the failure.
  function openAndDrain(ws: MockWebSocket) {
    act(() => ws.simulateOpen());
    act(() => ws.simulateMessage({ type: "history", messages: [] }));
  }

  it("is false before any failure", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    openAndDrain(wsInstances[0]!);
    expect(result.current.hasInlineError).toBe(false);
  });

  it("becomes true once an error frame injects an inline failure bubble", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    openAndDrain(ws);
    act(() =>
      ws.simulateMessage({
        type: "error",
        agentName: "Smithers",
        providerError: "LLM request failed.",
        messageId: "m1",
        runId: "r1",
      })
    );

    expect(result.current.hasInlineError).toBe(true);
  });

  it("clears back to false when a successful chunk dismisses the error bubble", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0]!;
    openAndDrain(ws);
    act(() =>
      ws.simulateMessage({
        type: "error",
        agentName: "Smithers",
        providerError: "LLM request failed.",
        messageId: "m1",
        runId: "r1",
      })
    );
    expect(result.current.hasInlineError).toBe(true);

    act(() =>
      ws.simulateMessage({ type: "chunk", content: "recovered", messageId: "m2", runId: "r2" })
    );
    expect(result.current.hasInlineError).toBe(false);
  });
});
