// @vitest-environment jsdom
/**
 * Pressing stop must keep the words that already arrived (#978).
 *
 * The stop button's whole promise is "keep what you have, stop paying for the
 * rest". `onCancel` says so out loud — *"A user stop is a clean end of turn
 * (partial reply preserved), not a failure"* — and the E2E asserts it
 * (19-chat-stop-button.spec.ts step 5). That spec has now gone red three times
 * on unrelated PRs, each time with the partial reply gone from the DOM rather
 * than merely truncated.
 *
 * Nothing on the client knows the user aborted, and two things conspire:
 *
 * 1. OpenClaw surfaces a user abort as an ERROR (`decision=surface_error
 *    rawError=Request was aborted`), so Pinchy broadcasts an `error` frame for
 *    a run the user ended on purpose. The client turns that into an error
 *    bubble — which is also what flips `prevMessages.some((m) => m.error)` and
 *    so unlocks the DESTRUCTIVE history reconcile.
 * 2. `onCancel` clears `isRunningRef` immediately, which is exactly the guard
 *    `requestHistoryCatchup` uses to refuse a mid-run re-pull. The next `poke`
 *    — and the abort produces one — therefore re-pulls, and the server history
 *    for an aborted run has the user turn but no assistant reply.
 *
 * The reconcile then adopts that shorter history wholesale and the partial
 * reply is gone. It is a race only in WHEN the poke lands, which is why it
 * reads as a flake instead of as the product bug it is.
 *
 * These tests pin the invariant at the level where the text is lost: whatever
 * the server says afterwards, a reply the user stopped stays on screen.
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

type Converted = {
  id: string;
  role: string;
  content?: Array<{ type: string; text?: string }>;
  // `convertMessage` moves an error bubble's payload under `metadata.custom` —
  // reading `.error` off the converted message is vacuously undefined, so an
  // assertion written that way passes without looking at anything.
  metadata?: { custom?: { error?: unknown } };
};
function messagesOf(runtime: unknown): Converted[] {
  return ((runtime as { messages?: Converted[] }).messages ?? []) as Converted[];
}
function renderedText(runtime: unknown): string {
  return messagesOf(runtime)
    .flatMap((m) => (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? ""))
    .join(" ");
}
function sendText(result: { current: { runtime: unknown } }, text: string) {
  (
    result.current.runtime as {
      onNew: (m: { content: { type: string; text: string }[]; parentId: string }) => void;
    }
  ).onNew({ content: [{ type: "text", text }], parentId: "root" });
}
async function cancel(result: { current: { runtime: unknown } }) {
  await (result.current.runtime as { onCancel: () => Promise<void> }).onCancel();
}

/** The exact frame OpenClaw's `surface_error` decision produces for an abort. */
const ABORT_ERROR_FRAME = {
  type: "error",
  agentName: "Smithers",
  providerError: "Request was aborted",
  messageId: "srv-1",
};

/**
 * A conversation with one settled turn, then a second turn stopped mid-stream
 * after a single word — the shape 19-chat-stop-button.spec.ts drives.
 */
function stopAfterFirstWord() {
  const { result } = renderHook(() => useWsRuntime("agent-1"));
  const ws = wsInstances[0]!;
  act(() => ws.simulateOpen());
  act(() =>
    ws.simulateMessage({
      type: "history",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "A" },
      ],
    })
  );
  act(() => sendText(result, "please respond slowly"));
  act(() => ws.simulateMessage({ type: "chunk", messageId: "srv-1", content: "lima" }));
  return { result, ws };
}

/** What the server holds for an aborted run: the user turn, no reply. */
const HISTORY_WITHOUT_THE_ABORTED_REPLY = {
  type: "history",
  messages: [
    { role: "user", content: "a" },
    { role: "assistant", content: "A" },
    { role: "user", content: "please respond slowly" },
  ],
};

describe("useWsRuntime — a stopped run keeps its partial reply (#978)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("survives the poke-driven history catch-up that follows the abort", async () => {
    const { result, ws } = stopAfterFirstWord();
    expect(renderedText(result.current.runtime)).toContain("lima");

    await act(async () => {
      await cancel(result);
    });
    act(() => ws.simulateMessage(ABORT_ERROR_FRAME));

    // The abort makes OpenClaw emit `session.message`, which the poke bridge
    // fans out to every device of the session — including this one. The
    // `isRunningRef` guard that would normally refuse a mid-run re-pull was
    // just cleared by `onCancel`.
    act(() => ws.simulateMessage({ type: "poke", sessionKey: "s", messageId: "srv-1" }));
    act(() => ws.simulateMessage(HISTORY_WITHOUT_THE_ABORTED_REPLY));
    act(() => vi.advanceTimersByTime(50)); // the staged destructive reconcile

    expect(renderedText(result.current.runtime)).toContain("lima");
  });

  it("survives a plain window-focus catch-up too, with no error frame at all", async () => {
    const { result, ws } = stopAfterFirstWord();

    await act(async () => {
      await cancel(result);
    });
    // No error frame here: a gateway that reports the abort cleanly still hits
    // the same re-pull, so the partial must not depend on the error's absence.
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => ws.simulateMessage(HISTORY_WITHOUT_THE_ABORTED_REPLY));
    act(() => vi.advanceTimersByTime(50));

    expect(renderedText(result.current.runtime)).toContain("lima");
  });

  it("does not blame the provider for a stop the user asked for", async () => {
    const { result, ws } = stopAfterFirstWord();

    await act(async () => {
      await cancel(result);
    });
    act(() => ws.simulateMessage(ABORT_ERROR_FRAME));

    const errorBubbles = messagesOf(result.current.runtime).filter(
      (m) => m.metadata?.custom?.error !== undefined
    );
    expect(errorBubbles).toHaveLength(0);
    // And the words are still there — an error bubble that REPLACED the reply
    // would leave this green on its own.
    expect(renderedText(result.current.runtime)).toContain("lima");
  });

  it("stops swallowing errors once the stopped turn has been terminated", async () => {
    const { result, ws } = stopAfterFirstWord();

    await act(async () => {
      await cancel(result);
    });
    // The server terminates a stopped run for everyone watching it — that is
    // what the `complete` frame is, and client-router now sends one down both
    // abort paths. It also bounds the suppression: the leftover error frame
    // this guard exists for travels AHEAD of the terminator, never behind it.
    // Anything that arrives afterwards is about something else, and swallowing
    // it would leave the user with a broken chat and no explanation.
    act(() => ws.simulateMessage({ type: "complete" }));
    act(() =>
      ws.simulateMessage({
        type: "error",
        agentName: "Smithers",
        providerError: "upstream exploded",
        messageId: "srv-2",
      })
    );

    const errorBubbles = messagesOf(result.current.runtime).filter(
      (m) => m.metadata?.custom?.error !== undefined
    );
    expect(errorBubbles).toHaveLength(1);
  });

  it("keeps the whole conversation when the catch-up finds history unavailable", async () => {
    const { result, ws } = stopAfterFirstWord();

    await act(async () => {
      await cancel(result);
    });
    // `messages: [], sessionKnown: true` is client-router's "the session exists
    // but OpenClaw can't answer right now" frame (a restart race, or the
    // history RPC throwing twice). `shouldReplaceLocalWithServerHistory` bails
    // on an EMPTY list precisely so that frame can never wipe a conversation —
    // a guard the stopped-reply anchor must not defeat by handing it a list of
    // one.
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => ws.simulateMessage({ type: "history", messages: [], sessionKnown: true }));
    act(() => vi.advanceTimersByTime(50));

    const text = renderedText(result.current.runtime);
    expect(text).toContain("lima");
    // The earlier, settled turn is what proves nothing was replaced: an anchor
    // that turned the empty frame into a one-message history would leave the
    // stopped reply alone on screen.
    expect(text).toContain("A");
    expect(messagesOf(result.current.runtime).length).toBeGreaterThanOrEqual(4);
  });

  it("still applies chunks buffered while the post-stop catch-up was in flight", async () => {
    const { result, ws } = stopAfterFirstWord();

    await act(async () => {
      await cancel(result);
    });
    // The catch-up is requested first, so everything the server sends until the
    // history frame lands is HELD in the pre-history buffer. The pipe's own
    // terminator is exactly that: on `done` it flushes the words it had
    // buffered for safe emission, which for a stopped run is the tail of the
    // very reply the stop was pressed to keep.
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => ws.simulateMessage({ type: "chunk", messageId: "srv-1", content: " charlie" }));
    act(() => ws.simulateMessage(HISTORY_WITHOUT_THE_ABORTED_REPLY));
    act(() => vi.advanceTimersByTime(50));

    expect(renderedText(result.current.runtime)).toContain("lima charlie");
  });
});
