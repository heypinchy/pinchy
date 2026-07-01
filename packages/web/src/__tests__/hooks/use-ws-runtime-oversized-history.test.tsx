/**
 * Regression guard for the vanishing/degraded user-message bug found in
 * v0.8.0 staging: a user sent an image to a text-only-model agent (the
 * vision-offload described it correctly), then refocused the tab minutes
 * later — the user's own message (text + image) had disappeared, leaving
 * only the assistant's reply.
 *
 * Root cause: OpenClaw's `chat.history` RPC caps single-message size (128 KB
 * — an inline image routinely trips this) and replaces an oversized message
 * with a fixed placeholder, discarding the original text AND the
 * `<pinchy:attachments>` block embedded in it. Before the fix,
 * client-router.ts's fetchAndParseHistory reduced that placeholder to ""
 * (the timestamp-strip regex matches the whole bracketed string) and the
 * content-or-files filter dropped the row entirely. Even with that server
 * fix (which now flags the row `oversized: true` and keeps a friendly
 * placeholder), the client's history-reconcile would still REPLACE the rich
 * local message — the exact text + file chip this tab already rendered at
 * send time — with the degraded server placeholder on any refocus/reconnect.
 * `preserveRicherLocalOverOversizedHistory` is what stops that.
 *
 * Same testing approach as use-ws-runtime-refocus-shrink.test.tsx: a WS
 * close+reconnect drives the IDENTICAL history-reconcile path as a real tab
 * refocus, deterministically and without needing a real browser. This is a
 * completed turn (no activeRun) — unlike the shrink-crash scenario, this path
 * already runs behind the isReconcilingMessages unmount gate
 * (stageDestructiveHistoryReconcile), so there's no separate crash risk here;
 * the observable bug is purely the reconciled CONTENT, which jsdom can
 * assert on directly.
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

type ConvertedMessage = {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
};
function textsOf(runtime: unknown): Array<{ role: string; text: string }> {
  const messages = ((runtime as { messages?: ConvertedMessage[] }).messages ??
    []) as ConvertedMessage[];
  return messages.map((m) => ({
    role: m.role,
    text: m.content.find((p) => p.type === "text")?.text ?? "",
  }));
}
function sendText(result: { current: { runtime: unknown } }, text: string) {
  (
    result.current.runtime as {
      onNew: (m: { content: { type: string; text: string }[]; parentId: string }) => void;
    }
  ).onNew({ content: [{ type: "text", text }], parentId: "root" });
}

const OVERSIZED_PLACEHOLDER_TEXT = "This message was too large to reload from history.";

describe("useWsRuntime — refocus reconcile must not clobber a richer local message with an oversized-history placeholder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the original user text after a completed turn's message becomes oversized in history", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = wsInstances[0]!;
    act(() => ws1.simulateOpen());

    act(() => ws1.simulateMessage({ type: "history", messages: [] }));

    const originalText = "Was hältst du von dem Bild?";
    act(() => sendText(result, originalText));
    act(() =>
      ws1.simulateMessage({
        type: "chunk",
        messageId: "srv-1",
        content: "Ein richtig schönes Bild! Es zeigt einen Jungen …",
      })
    );
    act(() => ws1.simulateMessage({ type: "complete" }));

    expect(result.current.isRunning).toBe(false);
    const before = textsOf(result.current.runtime);
    expect(before).toEqual([
      { role: "user", text: originalText },
      { role: "assistant", text: "Ein richtig schönes Bild! Es zeigt einen Jungen …" },
    ]);

    // Tab backgrounded → ws drops → reconnect → refocus history request.
    // OpenClaw's history now reports the user turn as oversized (server-side
    // already translated per client-router.ts fetchAndParseHistory) — the
    // exact frame shape client-router.ts sends after the Layer-1 fix.
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
          { role: "user", content: OVERSIZED_PLACEHOLDER_TEXT, oversized: true },
          { role: "assistant", content: "Ein richtig schönes Bild! Es zeigt einen Jungen …" },
        ],
      })
    );

    const after = textsOf(result.current.runtime);
    // The rich local text must survive — NOT be replaced by the degraded
    // server placeholder, and NOT vanish entirely.
    expect(after).toEqual(before);
  });
});
