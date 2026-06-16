/**
 * Canonical test suite for useWsRuntime.
 *
 * Covers system aspects (reconnect, agent switching, history reload, delay/
 * stuck timers, 1009 frame handling) AND the callback API (`onRetryContinue`,
 * `onRetryResend`, status-reducer flow, `isOpenClawConnected`).
 *
 * One mocking strategy throughout: real WebSocket via `vi.stubGlobal` +
 * the hook's `result.current.runtime` exposes the config that was passed to
 * `useExternalStoreRuntime` (the mock is the identity function), so tests
 * call `result.current.runtime.onNew(...)` and read `runtime.messages`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";
import { useChatStatus } from "@/hooks/use-chat-status";
import {
  CLIENT_IMAGE_COMPRESSION_TARGET_BYTES,
  CLIENT_MAX_ATTACHMENT_SIZE_BYTES,
} from "@/lib/limits";
import * as imageCompression from "@/lib/image-compression";

// Mock image compression module — real Canvas API is unavailable in jsdom.
// Default returns the new CompressionResult shape: ok=true with skipped=true
// (the file was small enough that no compression was needed). Tests that exercise
// the compression or failure paths override this with mockResolvedValueOnce.
vi.mock("@/lib/image-compression", () => ({
  compressImageForChat: vi.fn(async (file: File) => ({
    ok: true,
    file,
    skipped: true,
  })),
}));

// Track all created WebSocket instances
let wsInstances: MockWebSocket[] = [];

// Mock WebSocket
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

  /** Trigger onopen so the WS is considered connected */
  simulateOpen() {
    this.onopen?.(new Event("open"));
  }

  /** Deliver a JSON-serialised frame to onmessage */
  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1006) {
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

/** Returns the most recently created MockWebSocket instance */
function latestWs(): MockWebSocket {
  const ws = wsInstances[wsInstances.length - 1];
  if (!ws) throw new Error("No MockWebSocket instance created yet");
  return ws;
}

/** Minimal AppendMessage shape that onNew expects for a simple text message */
function makeUserMessage(text: string) {
  return {
    content: [{ type: "text", text }],
    attachments: [],
  };
}

vi.mock("@/lib/upload-attachment", () => ({
  uploadAttachment: vi.fn(),
}));

const mockToast = vi.fn();
vi.mock("sonner", () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));

const mockTriggerRestart = vi.fn();
vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ isRestarting: false, triggerRestart: mockTriggerRestart }),
}));

// Mock @assistant-ui/react with attachment adapters
vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: (config: any) => config,
  SimpleImageAttachmentAdapter: class {
    accept = "image/*";
  },
  SimpleTextAttachmentAdapter: class {
    accept = "text/plain,text/html,text/markdown,text/csv,text/xml,text/json,text/css";
  },
  CompositeAttachmentAdapter: class {
    accept: string;
    constructor(adapters: { accept: string }[]) {
      this.accept = adapters.map((a: { accept: string }) => a.accept).join(",");
    }
  },
}));

describe("useWsRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
    // Default: compression returns the skip-path result (ok=true, skipped=true)
    // — real Canvas unavailable in jsdom, and most tests don't care about compression.
    vi.mocked(imageCompression.compressImageForChat).mockImplementation(async (file) => ({
      ok: true,
      file,
      skipped: true,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return a runtime and connection status", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    expect(result.current.runtime).toBeDefined();
    expect(result.current.isConnected).toBe(false);
  });

  it("should stop running immediately when a complete message is received", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    // Connect and send a user message to set isRunning=true
    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    // Receive a chunk (isRunning should still be true)
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "chunk",
          content: "Hi there",
          messageId: "msg-1",
        }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(true);

    // Per-turn done — must NOT stop the spinner. The agent might still be
    // running another turn (tool-use loops), and only "complete" tells us
    // the entire stream is over.
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "done", messageId: "msg-1" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(true);

    // Stream-terminating complete event — now the spinner can stop.
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "complete" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(false);
  });

  it("should keep running across long pauses between chunks (no debounce false-positive)", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "chunk",
          content: "Let me think...",
          messageId: "msg-1",
        }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(true);

    // Simulate a long pause where the local LLM is generating the next turn
    // but no chunks arrive. The previous implementation debounced isRunning
    // to false after 1.5s of silence — that was the bug.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(result.current.runtime.isRunning).toBe(true);
  });

  it("should stop running immediately when an error message is received", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    expect(result.current.runtime.isRunning).toBe(true);

    // Receive error message - should immediately stop running
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "error",
          message: "Something went wrong",
          messageId: "msg-1",
        }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(false);

    // Should show the error as an assistant message with structured error in metadata
    const messages = result.current.runtime.messages;
    const errorMsg = messages.find(
      (m: any) =>
        m.role === "assistant" && m.metadata?.custom?.error?.message === "Something went wrong"
    );
    expect(errorMsg).toBeDefined();
  });

  it("should store structured provider error data from error message", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "error",
          agentName: "Smithers",
          providerError: "Your credit balance is too low.",
          hint: "Please contact your administrator.",
          messageId: "msg-1",
        }),
      });
    });

    const messages = result.current.runtime.messages;
    const errorMsg = messages.find((m: any) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorMsg).toBeDefined();
    expect(errorMsg.metadata.custom.error).toEqual({
      agentName: "Smithers",
      providerError: "Your credit balance is too low.",
      hint: "Please contact your administrator.",
    });
  });

  it("should store generic error message when no providerError is present", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "error",
          message: "Access denied",
          messageId: "msg-1",
        }),
      });
    });

    const messages = result.current.runtime.messages;
    const errorMsg = messages.find((m: any) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorMsg).toBeDefined();
    expect(errorMsg.metadata.custom.error).toEqual({
      message: "Access denied",
    });
  });

  it("forwards a valid upstreamFormatError payload onto the error metadata (issue #338)", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "error",
          agentName: "Smithers",
          providerError:
            'rawError=400 "Function call is missing a thought_signature in functionCall parts."',
          hint: "Click Retry — the same message usually succeeds on the next try.",
          messageId: "msg-1",
          upstreamFormatError: {
            kind: "upstream_format_error",
            model: "ollama-cloud/gemini-3-flash-preview",
            errorPattern: "thought_signature",
            ref: "abc-123",
          },
        }),
      });
    });

    const messages = result.current.runtime.messages;
    const errorMsg = messages.find((m: any) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorMsg).toBeDefined();
    expect(errorMsg.metadata.custom.error.upstreamFormatError).toEqual({
      kind: "upstream_format_error",
      model: "ollama-cloud/gemini-3-flash-preview",
      errorPattern: "thought_signature",
      ref: "abc-123",
    });
  });

  it("drops a malformed upstreamFormatError payload (defense-in-depth zod safeParse, issue #338)", () => {
    // If a stale Pinchy server or a hypothetical replay attack ever sends a
    // frame whose `upstreamFormatError` shape doesn't match the schema (wrong
    // kind, missing model, unknown errorPattern, …) the hook must NOT pass
    // the untrusted object through to the UI — otherwise the bubble component
    // could render a "Retry usually clears it" message for a completely
    // unrelated error and mislead the user. The bare providerError text stays
    // available so the generic error bubble still shows.
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "error",
          agentName: "Smithers",
          providerError: "Some upstream error",
          messageId: "msg-1",
          // Malformed: wrong `kind` discriminator, no `model`, unknown
          // `errorPattern` literal. zod must reject this.
          upstreamFormatError: {
            kind: "something_else",
            errorPattern: "made_up_pattern",
            ref: 42,
          },
        }),
      });
    });

    const messages = result.current.runtime.messages;
    const errorMsg = messages.find((m: any) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorMsg).toBeDefined();
    expect(errorMsg.metadata.custom.error.upstreamFormatError).toBeUndefined();
    // The bare error text is still rendered so the generic bubble can show up.
    expect(errorMsg.metadata.custom.error.providerError).toBe("Some upstream error");
  });

  describe("authoritative liveness frames", () => {
    function sendAndOpen(result: ReturnType<typeof renderHook>["result"], ws: MockWebSocket) {
      act(() => {
        ws.onopen?.();
      });
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });
    }

    it("shows a retryable failure bubble when a liveness:failed frame arrives", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];
      sendAndOpen(result, ws);
      expect(result.current.runtime.isRunning).toBe(true);

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "liveness",
            state: "failed",
            reason: "the agent run ended without a response",
          }),
        });
      });

      // Spinner stops and a retryable bubble carrying the server reason shows.
      expect(result.current.runtime.isRunning).toBe(false);
      const messages = result.current.runtime.messages;
      const failureMsg = messages.find(
        (m: any) =>
          m.role === "assistant" &&
          m.metadata?.custom?.error?.message === "the agent run ended without a response"
      );
      expect(failureMsg).toBeDefined();
      expect(failureMsg.metadata.custom.retryable).toBe(true);
    });

    it("falls back to a generic reason when liveness:failed omits one", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];
      sendAndOpen(result, ws);

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: "liveness", state: "failed" }) });
      });

      const messages = result.current.runtime.messages;
      const failureMsg = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.message
      );
      expect(failureMsg).toBeDefined();
      expect(failureMsg.metadata.custom.error.message).toBe(
        "The agent run ended without a response."
      );
    });

    it("keeps the richer error bubble when liveness:failed follows an error frame", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];
      sendAndOpen(result, ws);

      // The server emits the rich `error` frame first, then the additive
      // `liveness: failed` verdict. The generic liveness bubble must NOT
      // clobber the detailed provider-error bubble.
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "error",
            agentName: "Smithers",
            providerError: "Your credit balance is too low.",
            hint: "Please contact your administrator.",
            messageId: "msg-1",
          }),
        });
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "liveness",
            state: "failed",
            reason: "Your credit balance is too low.",
          }),
        });
      });

      const messages = result.current.runtime.messages;
      const errorMsgs = messages.filter(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error
      );
      // Exactly one bubble, and it is the rich provider-error one.
      expect(errorMsgs).toHaveLength(1);
      expect(errorMsgs[0].metadata.custom.error.providerError).toBe(
        "Your credit balance is too low."
      );
      expect(errorMsgs[0].metadata.custom.error.message).toBeUndefined();
    });

    it("liveness:responding keeps the run going and liveness:completed stops it without a bubble", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];
      sendAndOpen(result, ws);

      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: "liveness", state: "responding" }) });
      });
      expect(result.current.runtime.isRunning).toBe(true);

      // A completed verdict does not itself stop the spinner — `complete` is the
      // genuine terminator — but it must never produce a failure bubble.
      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: "liveness", state: "completed" }) });
      });
      const messages = result.current.runtime.messages;
      const errorMsg = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error
      );
      expect(errorMsg).toBeUndefined();
    });
  });

  it("should stay running when only done arrives (turn end), and stop on complete", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "chunk",
          content: "Hi",
          messageId: "msg-1",
        }),
      });
    });

    // Per-turn done — does NOT terminate the spinner
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "done", messageId: "msg-1" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(true);

    // Stream-terminating complete — now spinner stops
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "complete" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(false);

    // Advance past any old debounce window — must stay false
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.runtime.isRunning).toBe(false);
  });

  it("should create separate messages for each turn in a multi-turn stream", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    // User sends a message
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "How big is the house?" }],
        parentId: "root",
      });
    });

    // Turn 1: agent searches
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "chunk", content: "Let me search...", messageId: "turn-1" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(true);

    // Turn 1 done
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "done", messageId: "turn-1" }),
      });
    });

    // Turn 2: agent responds with new messageId
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "chunk",
          content: "The house is 231m².",
          messageId: "turn-2",
        }),
      });
    });

    // isRunning should be true again when new chunks arrive
    expect(result.current.runtime.isRunning).toBe(true);

    // Turn 2 done — still not finished from the spinner's perspective
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "done", messageId: "turn-2" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(true);

    // Stream complete — spinner stops
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "complete" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(false);

    // Should have 3 messages: user + 2 assistant turns
    const messages = result.current.runtime.messages;
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content[0].text).toBe("Let me search...");
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content[0].text).toBe("The house is 231m².");
  });

  it("should send message without sessionKey", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    // calls[0] is the history request, calls[1] is the user message
    const sentMessage = JSON.parse(ws.send.mock.calls[1][0]);
    expect(sentMessage.type).toBe("message");
    expect(sentMessage.content).toBe("Hello");
    expect(sentMessage.agentId).toBe("agent-1");
    expect(sentMessage.sessionKey).toBeUndefined();
  });

  it("registers a code/docx-only attachment adapter (everything else goes via two-phase upload)", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const runtime = result.current.runtime;

    expect(runtime.adapters).toBeDefined();
    expect(runtime.adapters.attachments).toBeDefined();

    const acceptedTypes = runtime.adapters.attachments.accept;
    // Source-code extensions are inlined as text content parts.
    expect(acceptedTypes).toContain(".ts");
    expect(acceptedTypes).toContain(".js");
    expect(acceptedTypes).toContain(".py");
    // .docx is extracted to text via mammoth in OfficeDocumentAttachmentAdapter.
    expect(acceptedTypes).toContain(".docx");
    // The following MIMEs must NOT be in the assistant-ui adapter chain — they
    // all go through the two-phase upload pipeline (PinchyAttachmentButton →
    // addPendingUpload → POST /uploads):
    //   - Images / PDFs would otherwise become legacy `image_url` parts the
    //     server rejects with PROTOCOL_OUTDATED.
    //   - Plain text / CSV / Markdown / JSON / YAML (issue #392) are workspace
    //     data files read by `pinchy_read` — they belong in the upload pipeline,
    //     not inlined as text.
    expect(acceptedTypes).not.toContain("image/*");
    expect(acceptedTypes).not.toContain("application/pdf");
    expect(acceptedTypes).not.toContain("text/plain");
    expect(acceptedTypes).not.toContain("text/csv");
    expect(acceptedTypes).not.toContain("text/markdown");
  });

  it("should send plain string when message has no image attachment", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello plain" }],
        parentId: "root",
      });
    });

    // calls[0] is the history request, calls[1] is the user message
    const sentMessage = JSON.parse(ws.send.mock.calls[1][0]);
    expect(sentMessage.content).toBe("Hello plain");
  });

  // Image/PDF send-path behaviour (size limits, compression, fail-closed on
  // unsupported formats) moved to addPendingUpload / POST /uploads when the
  // legacy base64 `image_url` flow was retired. Coverage lives in:
  //   - src/__tests__/hooks/use-pending-uploads.test.ts (client-side compression
  //     and the "fails closed for oversized non-JPEG/PNG" path)
  //   - src/__tests__/api/uploads-post.integration.test.ts (server-side size
  //     and MIME rejection — POST returns 413 / 415)

  it("should send history request on connect with agentId", () => {
    renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "history", agentId: "agent-1" }));
  });

  it("should populate messages from history response", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "history",
          messages: [
            { role: "user", content: "Hello", timestamp: "2026-01-01T00:00:00Z" },
            { role: "assistant", content: "Hi!", timestamp: "2026-01-01T00:00:01Z" },
          ],
        }),
      });
    });

    const messages = result.current.runtime.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0].text).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content[0].text).toBe("Hi!");
  });

  it("should map system role to assistant in history messages", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "history",
          messages: [
            { role: "system", content: "System prompt", timestamp: "2026-01-01T00:00:00Z" },
          ],
        }),
      });
    });

    const messages = result.current.runtime.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });

  it("should not overwrite existing messages when history arrives late", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    // User sends a message first (creating a non-empty messages array)
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "New message" }],
        parentId: "root",
      });
    });

    // History arrives after user already started chatting
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "history",
          messages: [
            { role: "user", content: "Old message" },
            { role: "assistant", content: "Old response" },
          ],
        }),
      });
    });

    const messages = result.current.runtime.messages;
    // Should still have the user's new message, not the history
    expect(messages[0].content[0].text).toBe("New message");
  });

  it("should replace a partial assistant message with canonical history after reconnect", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = wsInstances[0];

    act(() => {
      ws1.onopen?.();
    });

    act(() => {
      ws1.onmessage?.({
        data: JSON.stringify({
          type: "history",
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hallo!" },
          ],
        }),
      });
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Wie ist die Vacation Policy?" }],
        parentId: "root",
      });
    });

    act(() => {
      ws1.onmessage?.({
        data: JSON.stringify({
          type: "chunk",
          content: "Ich schaue nach. Urlaub**: 25 Tage",
          messageId: "assistant-1",
        }),
      });
    });

    let messages = result.current.runtime.messages;
    expect(messages[messages.length - 1].content[0].text).toContain("Urlaub**");

    // Simulate a disconnect and reconnect cycle.
    act(() => {
      ws1.onclose?.();
      vi.advanceTimersByTime(1000);
    });

    const ws2 = wsInstances[1];
    act(() => {
      ws2.onopen?.();
    });

    act(() => {
      ws2.onmessage?.({
        data: JSON.stringify({
          type: "history",
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hallo!" },
            { role: "user", content: "Wie ist die Vacation Policy?" },
            { role: "assistant", content: "Ich schaue nach. **Urlaubsanspruch:** 25 Tage" },
          ],
        }),
      });
    });

    messages = result.current.runtime.messages;
    expect(messages[messages.length - 1].content[0].text).toBe(
      "Ich schaue nach. **Urlaubsanspruch:** 25 Tage"
    );
  });

  it("should pass timestamps from history messages into metadata", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "history",
          messages: [
            { role: "user", content: "Hello", timestamp: "2026-02-20T21:30:00Z" },
            { role: "assistant", content: "Hi!", timestamp: "2026-02-20T21:30:05Z" },
          ],
        }),
      });
    });

    const messages = result.current.runtime.messages;
    expect(messages[0].metadata).toEqual({ custom: { timestamp: "2026-02-20T21:30:00Z" } });
    expect(messages[1].metadata).toEqual({ custom: { timestamp: "2026-02-20T21:30:05Z" } });
  });

  it("should not include metadata when history message has no timestamp", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "history",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
    });

    const messages = result.current.runtime.messages;
    expect(messages[0].metadata).toBeUndefined();
  });

  it("should set timestamp on new user messages", () => {
    vi.setSystemTime(new Date("2026-03-15T10:30:00Z"));

    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    const messages = result.current.runtime.messages;
    expect(messages[0].metadata).toEqual({
      custom: { timestamp: "2026-03-15T10:30:00.000Z", status: "sending" },
    });
  });

  it("should set timestamp on new assistant messages from chunks", () => {
    vi.setSystemTime(new Date("2026-03-15T10:30:05Z"));

    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    vi.setSystemTime(new Date("2026-03-15T10:30:10Z"));

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "chunk",
          content: "Hi there!",
          messageId: "msg-1",
        }),
      });
    });

    const messages = result.current.runtime.messages;
    const assistantMsg = messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg.metadata).toEqual({
      custom: { timestamp: "2026-03-15T10:30:10.000Z" },
    });
  });

  // "should store image data on user message for display" — removed. With the
  // two-phase upload pipeline, images on user messages are shown via the
  // `files` field (filename + mimeType) and an /api/agents/<id>/uploads/...
  // URL, not via an inline `image` part. The file-chip render is covered by
  // src/components/assistant-ui/__tests__/attachment-preview.test.tsx and the
  // upload-and-send E2E spec.

  describe("isDelayed", () => {
    it("should return isDelayed as false initially", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      expect(result.current.isDelayed).toBe(false);
    });

    it("should set isDelayed to true after 15 seconds without response", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      expect(result.current.isDelayed).toBe(false);

      // Advance 14 seconds — not yet delayed
      act(() => {
        vi.advanceTimersByTime(14000);
      });
      expect(result.current.isDelayed).toBe(false);

      // Advance to 15 seconds — now delayed
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.isDelayed).toBe(true);
    });

    it("should reset isDelayed when a chunk arrives", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      // Let it become delayed
      act(() => {
        vi.advanceTimersByTime(15000);
      });
      expect(result.current.isDelayed).toBe(true);

      // Chunk arrives — should reset
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "chunk",
            content: "Hi",
            messageId: "msg-1",
          }),
        });
      });
      expect(result.current.isDelayed).toBe(false);
    });

    it("should cancel delay timer when chunk arrives before timeout", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      // Chunk arrives at 5 seconds
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "chunk",
            content: "Hi",
            messageId: "msg-1",
          }),
        });
      });

      // Advance past 15 seconds — should NOT be delayed since chunk arrived
      act(() => {
        vi.advanceTimersByTime(15000);
      });
      expect(result.current.isDelayed).toBe(false);
    });

    it("should reset isDelayed on done message", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      act(() => {
        vi.advanceTimersByTime(15000);
      });
      expect(result.current.isDelayed).toBe(true);

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "chunk",
            content: "Response",
            messageId: "msg-1",
          }),
        });
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "done", messageId: "msg-1" }),
        });
      });

      expect(result.current.isDelayed).toBe(false);
    });

    it("should reset isDelayed on error message", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      act(() => {
        vi.advanceTimersByTime(15000);
      });
      expect(result.current.isDelayed).toBe(true);

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "error",
            message: "Something went wrong",
            messageId: "msg-1",
          }),
        });
      });

      expect(result.current.isDelayed).toBe(false);
    });

    it("should not be delayed when no message has been sent", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      // Advance time without sending a message
      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(result.current.isDelayed).toBe(false);
    });
  });

  describe("isHistoryLoaded", () => {
    it("should return isHistoryLoaded as false initially", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      expect(result.current.isHistoryLoaded).toBe(false);
    });

    it("should set isHistoryLoaded to true when history message is received", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [],
          }),
        });
      });

      expect(result.current.isHistoryLoaded).toBe(true);
    });

    it("should set isHistoryLoaded to true when history has messages", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [{ role: "assistant", content: "Hello!" }],
          }),
        });
      });

      expect(result.current.isHistoryLoaded).toBe(true);
    });

    it("should reset isHistoryLoaded to false on disconnect", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "history", messages: [] }),
        });
      });

      expect(result.current.isHistoryLoaded).toBe(true);

      act(() => {
        ws.onclose?.();
      });

      expect(result.current.isHistoryLoaded).toBe(false);
    });
  });

  describe("hasInitialContent", () => {
    // Issue #197: gate the transition out of "starting" on having something
    // renderable (a message or an authoritative empty signal). Otherwise the
    // indicator can flip green while the chat is briefly blank.
    it("is false initially", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      expect(result.current.hasInitialContent).toBe(false);
    });

    it("is false when server returns empty history without sessionKnown flag", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "history", messages: [] }),
        });
      });

      expect(result.current.hasInitialContent).toBe(false);
    });

    it("becomes true when history arrives with at least one message", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [{ role: "assistant", content: "Hello!" }],
          }),
        });
      });

      expect(result.current.hasInitialContent).toBe(true);
    });

    it("becomes true when server signals sessionKnown with empty history", () => {
      // OpenClaw restart race: session exists, history temporarily unavailable.
      // We must leave "starting" instead of waiting forever for messages.
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [],
            sessionKnown: true,
          }),
        });
      });

      expect(result.current.hasInitialContent).toBe(true);
    });

    it("transitions chatStatus from 'starting' to 'ready' atomically with the message arriving", () => {
      // Issue #197 — the whole point of this fix: when the history frame
      // arrives, the indicator must not flip green before the message is on
      // screen. We assert atomicity by composing useWsRuntime + useChatStatus
      // and observing both in the same render snapshot.
      const { result } = renderHook(() => {
        const ws = useWsRuntime("agent-1");
        const status = useChatStatus({
          isConnected: ws.isConnected,
          isOpenClawConnected: ws.isOpenClawConnected,
          isHistoryLoaded: ws.isHistoryLoaded,
          hasInitialContent: ws.hasInitialContent,
          isRunning: ws.isRunning,
          reconnectExhausted: ws.reconnectExhausted,
          payloadRejected: ws.payloadRejected,
          configuring: false,
        });
        return { ws, status };
      });

      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
        ws.onmessage?.({
          data: JSON.stringify({ type: "openclaw_status", connected: true }),
        });
      });

      // Connected upstream + downstream, but no content yet → still "starting".
      expect(result.current.status).toEqual({ kind: "starting" });
      expect(result.current.ws.runtime.messages).toHaveLength(0);

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [{ role: "assistant", content: "Hello!" }],
          }),
        });
      });

      // Single render after the history frame: status is 'ready' AND the
      // message is in the runtime. Both flip in the same React batch — there
      // is no intermediate snapshot where the indicator is green but the
      // chat is empty.
      expect(result.current.status).toEqual({ kind: "ready" });
      expect(result.current.ws.runtime.messages).toHaveLength(1);
    });

    it("clears the knownEmptyHistory signal on disconnect", () => {
      // hasInitialContent must not stay true purely because of a stale "known empty"
      // signal after the connection drops — otherwise on reconnect we'd
      // briefly show "ready" before fresh history arrives.
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "history", messages: [], sessionKnown: true }),
        });
      });
      expect(result.current.hasInitialContent).toBe(true);

      act(() => {
        ws.onclose?.();
      });

      expect(result.current.hasInitialContent).toBe(false);
    });
  });

  describe("auto-reconnect", () => {
    it("should reconnect after connection closes unexpectedly", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      expect(wsInstances).toHaveLength(1);

      act(() => {
        ws.onclose?.();
      });

      // Advance past first reconnect delay (1 second)
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(wsInstances).toHaveLength(2);
    });

    it("should use exponential backoff for reconnect attempts", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
      });

      // First disconnect -> 1s delay
      act(() => {
        ws1.onclose?.();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(wsInstances).toHaveLength(2);

      // Second disconnect -> 2s delay
      const ws2 = wsInstances[1];
      act(() => {
        ws2.onclose?.();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(wsInstances).toHaveLength(2); // Not yet
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(wsInstances).toHaveLength(3);
    });

    it("should not reconnect when component unmounts", () => {
      const { unmount } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Should only have the original connection
      expect(wsInstances).toHaveLength(1);
    });

    it("should reset reconnect attempts on successful connection", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
      });

      // Disconnect and reconnect
      act(() => {
        ws1.onclose?.();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(wsInstances).toHaveLength(2);

      // Successful reconnect resets counter
      const ws2 = wsInstances[1];
      act(() => {
        ws2.onopen?.();
      });

      // Disconnect again - should use 1s delay (not 2s)
      act(() => {
        ws2.onclose?.();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(wsInstances).toHaveLength(3);
    });

    it("should cap backoff at 5 seconds", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
      });

      // Disconnect 4 times: delays are 1s, 2s, 4s, 5s (capped)
      for (let i = 0; i < 4; i++) {
        const ws = wsInstances[wsInstances.length - 1];
        act(() => {
          ws.onclose?.();
        });
        act(() => {
          vi.advanceTimersByTime(5000);
        });
      }

      // 5th disconnect: should still reconnect after 5s (not 16s or 32s)
      const ws5 = wsInstances[wsInstances.length - 1];
      act(() => {
        ws5.onclose?.();
      });

      // After 5s the next reconnect should happen (capped, not 16s)
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(wsInstances).toHaveLength(6); // original + 5 reconnects
    });

    it("should stop reconnecting after max attempts", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];
      act(() => {
        ws1.onopen?.();
      });

      // Simulate 10 disconnects without successful reconnect
      for (let i = 0; i < 10; i++) {
        const ws = wsInstances[wsInstances.length - 1];
        act(() => {
          ws.onclose?.();
        });
        act(() => {
          vi.advanceTimersByTime(5000);
        }); // Max delay (capped at 5s)
      }

      expect(wsInstances).toHaveLength(11); // original + 10 reconnects

      // 11th disconnect should NOT reconnect
      const lastWs = wsInstances[wsInstances.length - 1];
      act(() => {
        lastWs.onclose?.();
      });
      act(() => {
        vi.advanceTimersByTime(60000);
      });
      expect(wsInstances).toHaveLength(11); // No new connection
    });
  });

  describe("agent switching", () => {
    it("should reset messages when agentId changes", () => {
      const { result, rerender } = renderHook(({ agentId }) => useWsRuntime(agentId), {
        initialProps: { agentId: "agent-1" },
      });
      const ws1 = wsInstances[0];

      // Connect and load history for agent-1
      act(() => {
        ws1.onopen?.();
      });
      act(() => {
        ws1.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [
              { role: "user", content: "Hello" },
              { role: "assistant", content: "Hi from agent 1!" },
            ],
          }),
        });
      });

      expect(result.current.runtime.messages).toHaveLength(2);

      // Switch to agent-2
      rerender({ agentId: "agent-2" });
      const ws2 = wsInstances[1];

      // Connect to new agent
      act(() => {
        ws2.onopen?.();
      });

      // History from agent-2 arrives
      act(() => {
        ws2.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [{ role: "assistant", content: "Welcome to agent 2!" }],
          }),
        });
      });

      // Should show agent-2's history, NOT agent-1's
      const messages = result.current.runtime.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].content[0].text).toBe("Welcome to agent 2!");
    });

    it("should load history for new agent even when previous agent had messages", () => {
      const { result, rerender } = renderHook(({ agentId }) => useWsRuntime(agentId), {
        initialProps: { agentId: "agent-1" },
      });
      const ws1 = wsInstances[0];

      // Chat with agent-1
      act(() => {
        ws1.onopen?.();
      });
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello agent 1" }],
          parentId: "root",
        });
      });

      // Switch to agent-2
      rerender({ agentId: "agent-2" });
      const ws2 = wsInstances[1];

      act(() => {
        ws2.onopen?.();
      });

      // Agent-2 has empty history
      act(() => {
        ws2.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [],
          }),
        });
      });

      // Should be empty — agent-1's messages must not leak into agent-2
      expect(result.current.runtime.messages).toHaveLength(0);
    });
  });

  describe("message queuing when disconnected", () => {
    it("should queue message and send it when WebSocket becomes open", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      // WebSocket is still CONNECTING (readyState = 0)
      ws.readyState = 0;

      // User sends a message before connection is open
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello while connecting" }],
          parentId: "root",
        });
      });

      // Message should NOT have been sent yet (only history request attempt or nothing)
      const messageSends = ws.send.mock.calls.filter(
        (call: string[]) => JSON.parse(call[0]).type === "message"
      );
      expect(messageSends).toHaveLength(0);

      // User message should still appear optimistically in messages, followed
      // by the in-flight assistant placeholder the send path appends (the
      // tab-refocus crash fix — list always ends in assistant while running).
      const messages = result.current.runtime.messages;
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content[0].text).toBe("Hello while connecting");
      expect(messages[1].role).toBe("assistant");

      // Now the connection opens
      ws.readyState = 1;
      act(() => {
        ws.onopen?.();
      });

      // The queued message should now be sent
      const sentMessages = ws.send.mock.calls.filter(
        (call: string[]) => JSON.parse(call[0]).type === "message"
      );
      expect(sentMessages).toHaveLength(1);
      expect(JSON.parse(sentMessages[0][0]).content).toBe("Hello while connecting");
    });

    it("should send queued message after reconnect", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      // Connect first
      ws1.readyState = 1;
      act(() => {
        ws1.onopen?.();
      });

      // Disconnect
      ws1.readyState = 3; // CLOSED
      act(() => {
        ws1.onclose?.();
      });

      // User sends message while disconnected
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Sent while offline" }],
          parentId: "root",
        });
      });

      // Reconnect
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      const ws2 = wsInstances[1];
      ws2.readyState = 1;
      act(() => {
        ws2.onopen?.();
      });

      // The queued message should be sent on the new connection
      const sentMessages = ws2.send.mock.calls.filter(
        (call: string[]) => JSON.parse(call[0]).type === "message"
      );
      expect(sentMessages).toHaveLength(1);
      expect(JSON.parse(sentMessages[0][0]).content).toBe("Sent while offline");
    });

    it("queues while the WebSocket is closing without opening an overlapping connection", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
      });

      ws1.readyState = MockWebSocket.CLOSING;

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Sent while closing" }],
          parentId: "root",
        });
      });

      expect(wsInstances).toHaveLength(1);

      act(() => {
        ws1.simulateClose();
        vi.advanceTimersByTime(1000);
      });

      const ws2 = wsInstances[1];
      ws2.readyState = MockWebSocket.OPEN;
      act(() => {
        ws2.onopen?.();
      });

      const sentMessages = ws2.send.mock.calls.filter(
        (call: string[]) => JSON.parse(call[0]).type === "message"
      );
      expect(sentMessages).toHaveLength(1);
      expect(JSON.parse(sentMessages[0][0]).content).toBe("Sent while closing");
    });
  });

  describe("disconnect during active stream", () => {
    it("should add a disconnect error message when stream is interrupted by a WebSocket error followed by close", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      expect(result.current.runtime.isRunning).toBe(true);

      // Real browser behavior: onerror always fires before onclose
      act(() => {
        ws.onerror?.();
        ws.onclose?.();
      });

      // Disconnect bubble is now deferred 2s — give a successful reconnect
      // a chance to land first (issue #199). Advance past the grace window
      // to surface the bubble for assertion.
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      const messages = result.current.runtime.messages;
      const disconnectError = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.disconnected === true
      );
      expect(disconnectError).toBeDefined();
    });

    it("should not inject a disconnect error into the new agent chat when switching during an active stream", () => {
      const { result, rerender } = renderHook(({ agentId }) => useWsRuntime(agentId), {
        initialProps: { agentId: "agent-1" },
      });
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
      });

      // Start a stream on agent-1
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });
      act(() => {
        ws1.onmessage?.({
          data: JSON.stringify({ type: "chunk", content: "Hi", messageId: "msg-1" }),
        });
      });

      // Switch to agent-2 while stream is active
      rerender({ agentId: "agent-2" });

      // Old connection closes (triggered by cleanup calling ws.close())
      act(() => {
        ws1.onclose?.();
      });

      // Agent-2's messages must be empty — no spurious disconnect error
      expect(result.current.runtime.messages).toHaveLength(0);
    });

    it("should add a disconnect error message when stream is interrupted by close", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      expect(result.current.runtime.isRunning).toBe(true);

      // Disconnect while stream is active
      act(() => {
        ws.onclose?.();
      });

      // Disconnect bubble is now deferred 2s — give a successful reconnect
      // a chance to land first (issue #199). Advance past the grace window
      // to surface the bubble for assertion.
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      const messages = result.current.runtime.messages;
      const disconnectError = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.disconnected === true
      );
      expect(disconnectError).toBeDefined();
    });

    it("should not add a disconnect error message when idle (no active stream)", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "history", messages: [] }),
        });
      });

      const messagesBefore = result.current.runtime.messages.length;

      // Disconnect while idle
      act(() => {
        ws.onclose?.();
      });

      expect(result.current.runtime.messages).toHaveLength(messagesBefore);
    });

    // Regression guard for #199: the disconnect bubble injection is deferred
    // by DISCONNECT_ERROR_GRACE_MS so a successful reconnect+history-reconcile
    // can land first. Without this, the messages array shrinks 4→3 during
    // reconcile and assistant-ui's index-based AssistantMessage subscription
    // throws "tapClientLookup: Index N out of bounds (length: N)" before the
    // trailing component can unmount. See use-ws-runtime.ts.
    it("does NOT inject the disconnect bubble when reconnect+history-reconcile lands within the grace window", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [{ role: "assistant", content: "Hi" }],
          }),
        });
      });

      // User sends → partial chunk → close mid-stream
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Wie ist die Vacation Policy?" }],
          parentId: "root",
        });
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "chunk",
            content: "Ich schaue nach. Urlaub**:",
            messageId: "asst-1",
          }),
        });
      });
      act(() => {
        ws.onclose?.();
      });

      // Bubble must NOT be present immediately — it's deferred.
      const beforeReconnect = result.current.runtime.messages;
      expect(
        beforeReconnect.find(
          (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.disconnected === true
        )
      ).toBeUndefined();

      // Reconnect runs after backoff (1s for first attempt)
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      const ws2 = wsInstances[1];
      act(() => {
        ws2.onopen?.();
      });
      act(() => {
        ws2.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [
              { role: "assistant", content: "Hi" },
              { role: "user", content: "Wie ist die Vacation Policy?" },
              {
                role: "assistant",
                content: "Ich schaue nach. **Urlaubsanspruch:** 25 Tage",
              },
            ],
          }),
        });
      });

      // Advance past the full grace window — bubble must STAY cancelled.
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      const finalMessages = result.current.runtime.messages;
      expect(
        finalMessages.find(
          (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.disconnected === true
        )
      ).toBeUndefined();
      // The canonical reply must be the last assistant message — proves the
      // history reconcile happened without an intermediate shrink.
      expect(finalMessages[finalMessages.length - 1].content[0].text).toBe(
        "Ich schaue nach. **Urlaubsanspruch:** 25 Tage"
      );
    });

    it("DOES inject the disconnect bubble when reconnect does not arrive within the grace window", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      act(() => {
        ws.onmessage?.({ data: JSON.stringify({ type: "history", messages: [] }) });
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });
      act(() => {
        ws.onclose?.();
      });

      // Advance past grace window with no reconnect/history.
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      const messages = result.current.runtime.messages;
      const disconnectError = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.disconnected === true
      );
      expect(disconnectError).toBeDefined();
    });

    it("stages a destructive history reconcile behind a message-subtree remount", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
        ws1.onmessage?.({ data: JSON.stringify({ type: "history", messages: [] }) });
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Summarize this profile" }],
          parentId: "root",
        });
      });
      act(() => {
        ws1.onmessage?.({
          data: JSON.stringify({
            type: "chunk",
            messageId: "asst-late",
            content: "Partial summary",
          }),
        });
        ws1.onclose?.();
      });

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      const localLength = result.current.runtime.messages.length;
      expect(localLength).toBeGreaterThan(2);

      const ws2 = wsInstances[1];
      act(() => {
        ws2.onopen?.();
        ws2.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [
              { role: "user", content: "Summarize this profile" },
              { role: "assistant", content: "Final summary" },
            ],
          }),
        });
      });

      expect(result.current.isReconcilingMessages).toBe(true);
      expect(result.current.runtime.messages).toHaveLength(localLength);

      act(() => {
        vi.advanceTimersByTime(0);
      });

      expect(result.current.runtime.messages).toHaveLength(2);
      expect(result.current.runtime.messages[1].content[0].text).toBe("Final summary");
      expect(result.current.isReconcilingMessages).toBe(true);

      act(() => {
        vi.advanceTimersByTime(16);
      });

      expect(result.current.isReconcilingMessages).toBe(false);
    });

    it("does not replay a disconnect bubble after the page resumes from sleep", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
        ws.onmessage?.({ data: JSON.stringify({ type: "history", messages: [] }) });
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Keep working while I close my laptop" }],
          parentId: "root",
        });
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "chunk",
            messageId: "asst-sleep",
            content: "Working on it...",
          }),
        });
      });

      act(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        ws.onclose?.();
      });

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(
        result.current.runtime.messages.find(
          (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.disconnected === true
        )
      ).toBeUndefined();

      act(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(wsInstances.length).toBeGreaterThan(1);
    });

    it("close-code 1009 surfaces 'Image too large' instead of generic disconnect", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
        ws.onmessage?.({ data: JSON.stringify({ type: "history", messages: [] }) });
      });

      // Send a message — 1009 is only meaningful in the context of a recent send
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "here's a huge image" }],
          parentId: "root",
        });
      });

      // Simulate the server closing because the frame exceeded maxPayload
      act(() => {
        ws.simulateClose(1009);
      });

      const messages = result.current.runtime.messages;
      const lastMsg = messages[messages.length - 1] as {
        role: string;
        metadata?: {
          custom?: {
            error?: { payloadTooLarge?: boolean; message?: string };
            retryable?: boolean;
          };
        };
      };
      expect(lastMsg.role).toBe("assistant");
      expect(lastMsg.metadata?.custom?.error?.payloadTooLarge).toBe(true);
      expect(lastMsg.metadata?.custom?.error?.message).toMatch(/too large/i);
      // Resending an oversized frame won't help — must NOT be retryable.
      // Convention: retryable is only written when true; absence means false.
      expect(lastMsg.metadata?.custom?.retryable).toBeUndefined();
    });

    it("close-code 1009 exposes payloadRejected status instead of reconnecting after hysteresis", () => {
      const { result } = renderHook(() => {
        const ws = useWsRuntime("agent-1");
        const status = useChatStatus({
          isConnected: ws.isConnected,
          isOpenClawConnected: ws.isOpenClawConnected,
          isHistoryLoaded: ws.isHistoryLoaded,
          hasInitialContent: ws.hasInitialContent,
          isRunning: ws.isRunning,
          reconnectExhausted: ws.reconnectExhausted,
          payloadRejected: ws.payloadRejected,
          configuring: false,
        });
        return { ws, status };
      });
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
        ws.onmessage?.({ data: JSON.stringify({ type: "openclaw_status", connected: true }) });
        ws.onmessage?.({ data: JSON.stringify({ type: "history", messages: [] }) });
      });

      act(() => {
        result.current.ws.runtime.onNew({
          content: [{ type: "text", text: "here's a huge image" }],
          parentId: "root",
        });
      });

      act(() => {
        ws.simulateClose(1009);
      });

      expect(result.current.status).toEqual({ kind: "payloadRejected" });

      act(() => {
        vi.advanceTimersByTime(2100);
      });

      expect(result.current.status).toEqual({ kind: "payloadRejected" });
    });

    it("sends the next message over a fresh WebSocket after close-code 1009", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const firstWs = wsInstances[0];

      act(() => {
        firstWs.onopen?.();
        firstWs.onmessage?.({ data: JSON.stringify({ type: "history", messages: [] }) });
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "oversized image" }],
          parentId: "root",
        });
      });

      act(() => {
        firstWs.simulateClose(1009);
      });

      expect(result.current.payloadRejected).toBe(true);
      expect(wsInstances).toHaveLength(1);

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "smaller image" }],
          parentId: "root",
        });
      });

      expect(result.current.payloadRejected).toBe(false);
      expect(wsInstances).toHaveLength(2);

      const nextWs = wsInstances[1];
      act(() => {
        nextWs.onopen?.();
      });

      expect(nextWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "history", agentId: "agent-1" })
      );
      expect(nextWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"content":"smaller image"')
      );
    });

    it("should reset isDelayed to false when WebSocket disconnects", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      // Let it become delayed
      act(() => {
        vi.advanceTimersByTime(15000);
      });
      expect(result.current.isDelayed).toBe(true);

      // Disconnect — isDelayed must clear
      act(() => {
        ws.onclose?.();
      });
      expect(result.current.isDelayed).toBe(false);
    });
  });

  describe("reconnectExhausted", () => {
    it("should return reconnectExhausted as false initially", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      expect(result.current.reconnectExhausted).toBe(false);
    });

    it("should set reconnectExhausted to true after all reconnect attempts fail", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
      });

      // Exhaust all MAX_RECONNECT_ATTEMPTS (10) + the original connection
      for (let i = 0; i < 10; i++) {
        const ws = wsInstances[wsInstances.length - 1];
        act(() => {
          ws.onclose?.();
        });
        act(() => {
          vi.advanceTimersByTime(5000);
        });
      }

      // 11th disconnect — no more reconnect attempts
      const lastWs = wsInstances[wsInstances.length - 1];
      act(() => {
        lastWs.onclose?.();
      });

      expect(result.current.reconnectExhausted).toBe(true);
    });

    it("should reset reconnectExhausted to false when reconnect succeeds", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws1 = wsInstances[0];

      act(() => {
        ws1.onopen?.();
      });

      // Fail a few times (but not all)
      for (let i = 0; i < 3; i++) {
        const ws = wsInstances[wsInstances.length - 1];
        act(() => {
          ws.onclose?.();
        });
        act(() => {
          vi.advanceTimersByTime(5000);
        });
      }

      // Successful reconnect
      const ws4 = wsInstances[wsInstances.length - 1];
      act(() => {
        ws4.onopen?.();
      });

      expect(result.current.reconnectExhausted).toBe(false);
    });
  });

  describe("stuck request timeout", () => {
    it("should add a timeout error message after 60 seconds without any activity", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      expect(result.current.runtime.isRunning).toBe(true);

      // 59 seconds — should still be running
      act(() => {
        vi.advanceTimersByTime(59_000);
      });
      expect(result.current.runtime.isRunning).toBe(true);

      // 60 seconds without any activity — stuck timeout fires
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(result.current.runtime.isRunning).toBe(false);

      const messages = result.current.runtime.messages;
      const timeoutError = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.timedOut === true
      );
      expect(timeoutError).toBeDefined();
    });

    it("should reset the stuck timer when a chunk arrives", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      // 50 seconds pass, then a chunk arrives
      act(() => {
        vi.advanceTimersByTime(50_000);
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "chunk", content: "Hi", messageId: "msg-1" }),
        });
      });

      // 50 more seconds — still under 60s from last activity, should not timeout
      act(() => {
        vi.advanceTimersByTime(50_000);
      });
      expect(result.current.runtime.isRunning).toBe(true);

      // 10 more seconds (60s since last chunk) — now it should timeout
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current.runtime.isRunning).toBe(false);
    });

    it("should reset the stuck timer when a thinking heartbeat arrives", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      // 50 seconds pass, then a thinking heartbeat arrives
      act(() => {
        vi.advanceTimersByTime(50_000);
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "thinking" }),
        });
      });

      // 59 more seconds — still under 60s from last heartbeat
      act(() => {
        vi.advanceTimersByTime(59_000);
      });
      expect(result.current.runtime.isRunning).toBe(true);
    });

    it("should clear the stuck timer when complete arrives", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "chunk", content: "Hi", messageId: "msg-1" }),
        });
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "complete" }),
        });
      });

      // Advance past 60s — should NOT fire timeout because stream is done
      act(() => {
        vi.advanceTimersByTime(120_000);
      });

      const messages = result.current.runtime.messages;
      const timeoutError = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.timedOut === true
      );
      expect(timeoutError).toBeUndefined();
    });

    it("should clear the stuck timer on disconnect", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Hello" }],
          parentId: "root",
        });
      });

      // Disconnect at 30s — should clear stuck timer
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      act(() => {
        ws.onclose?.();
      });

      // Advance to 90s total — stuck timer must NOT fire (it was cleared on disconnect)
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      const messages = result.current.runtime.messages;
      const timeoutErrors = messages.filter(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error?.timedOut === true
      );
      // Disconnect error yes, but no separate timeout error
      expect(timeoutErrors).toHaveLength(0);
    });

    it("should not start stuck timer when no message has been sent", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        vi.advanceTimersByTime(120_000);
      });

      expect(result.current.runtime.isRunning).toBe(false);
      expect(result.current.runtime.messages).toHaveLength(0);
    });
  });

  describe("openclaw restart messages", () => {
    it("should call triggerRestart when openclaw:restarting message is received", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "openclaw:restarting" }),
        });
      });

      expect(mockTriggerRestart).toHaveBeenCalledOnce();
    });

    it("should ignore openclaw:ready messages (RestartProvider handles transition)", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      // Should not throw or cause issues
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "openclaw:ready" }),
        });
      });

      // triggerRestart should NOT be called for ready messages
      expect(mockTriggerRestart).not.toHaveBeenCalled();
    });
  });

  describe("message-history cap (#199)", () => {
    it("drops the oldest messages once the bundle exceeds 200 entries", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });

      // Push 250 messages via a single history frame — the fastest path into
      // setMessages that doesn't require 250 individual WS round-trips.
      const historyPayload = Array.from({ length: 250 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message-${i}`,
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      }));

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "history", messages: historyPayload }),
        });
      });

      const messages = result.current.runtime.messages;
      expect(messages).toHaveLength(200);
      // The oldest 50 must be gone; the newest 200 must be retained.
      expect(messages[0].content[0].text).toBe("message-50");
      expect(messages[199].content[0].text).toBe("message-249");
    });
  });

  describe("auto-recovery on OpenClaw reconnect", () => {
    it("re-requests history when fullyConnected transitions false → true", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      // Step 1: fully connect, receive openclaw_status: true (server confirms
      // upstream readiness — required since the client default is now false,
      // see issue #198), and load history.
      act(() => {
        ws.onopen?.();
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "openclaw_status", connected: true }),
        });
      });
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "history",
            messages: [{ role: "assistant", content: "Hello!" }],
          }),
        });
      });

      expect(result.current.isHistoryLoaded).toBe(true);
      expect(result.current.isOpenClawConnected).toBe(true);

      // Step 2: OpenClaw goes unavailable (fullyConnected: true → false)
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "openclaw_status", connected: false }),
        });
      });
      expect(result.current.isOpenClawConnected).toBe(false);

      // Count sends so far
      const sendsBefore = ws.send.mock.calls.length;

      // Step 3: OpenClaw comes back (fullyConnected: false → true — rising edge)
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "openclaw_status", connected: true }),
        });
      });
      expect(result.current.isOpenClawConnected).toBe(true);

      // A { type: "history" } frame with the correct agentId must have been sent after the rising edge
      const historySentAfter = ws.send.mock.calls
        .slice(sendsBefore)
        .map((call: string[]) => JSON.parse(call[0]))
        .filter((msg: { type: string }) => msg.type === "history");
      expect(historySentAfter).toHaveLength(1);
      expect(historySentAfter[0].agentId).toBe("agent-1");
    });

    it("does NOT re-request history on initial mount (no false → true rising edge)", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      // Connect for the first time — ws.onopen already sends history
      act(() => {
        ws.onopen?.();
      });

      // Only one history request should have been sent (from onopen), not two
      const historyRequests = ws.send.mock.calls
        .map((call: string[]) => JSON.parse(call[0]))
        .filter((msg: { type: string }) => msg.type === "history");
      expect(historyRequests).toHaveLength(1);
    });

    it("does NOT re-request history when OpenClaw was never loaded (isHistoryLoaded = false)", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      // Connect but do NOT send history response yet (isHistoryLoaded stays false)
      act(() => {
        ws.onopen?.();
      });

      // isOpenClawConnected starts false (issue #198); simulate a false → true
      // transition without history loaded — the rising edge must NOT trigger
      // a history re-request because isHistoryLoaded is still false.
      const sendsBefore = ws.send.mock.calls.length;

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "openclaw_status", connected: true }),
        });
      });

      // isHistoryLoaded is still false — must NOT send another history request
      const historySentAfter = ws.send.mock.calls
        .slice(sendsBefore)
        .map((call: string[]) => JSON.parse(call[0]))
        .filter((msg: { type: string }) => msg.type === "history");
      expect(historySentAfter).toHaveLength(0);
    });
  });

  it("should set attachmentInvalid on ChatError when server sends attachment_invalid code", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "error",
          code: "attachment_invalid",
          message: "File type mismatch: claimed application/pdf, content is image/png",
        }),
      });
    });

    const messages = result.current.runtime.messages;
    const errorMsg = messages.find((m: any) => m.role === "assistant" && m.metadata?.custom?.error);
    expect(errorMsg).toBeDefined();
    expect(errorMsg.metadata.custom.error).toEqual({
      attachmentInvalid: true,
      message: "File type mismatch: claimed application/pdf, content is image/png",
    });
  });

  it.each([
    ["attachment_not_found", "Attachment(s) not found or not accessible: foo"],
    ["attachment_expired", "Attachment(s) have expired: foo"],
    ["attachment_already_attached", "Attachment(s) have already been attached: foo"],
  ])(
    "maps server code %s onto attachmentInvalid so the chat shows the dedicated 'Invalid file' UI",
    (code, message) => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      const ws = wsInstances[0];

      act(() => {
        ws.onopen?.();
      });
      act(() => {
        result.current.runtime.onNew({
          content: [{ type: "text", text: "Send a file" }],
          parentId: "root",
        });
      });

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "error", code, message }),
        });
      });

      const messages = result.current.runtime.messages;
      const errorMsg = messages.find(
        (m: any) => m.role === "assistant" && m.metadata?.custom?.error
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg.metadata.custom.error.attachmentInvalid).toBe(true);
      expect(errorMsg.metadata.custom.error.message).toBe(message);
    }
  );

  // ── status reducer + orphan detector ────────────────────────────────────────
  describe("status reducer + orphan detector", () => {
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("test message"));
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
      // History messages don't go through onNew, so no ack timer is armed for
      // them — an armed timer would flip status to "failed" after 10s. Assert
      // directly on the user message's status after 15s.
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({
          type: "history",
          messages: [{ role: "user", content: "old message" }],
        });
      });

      // Advance past the 10s ack timeout window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      const historyUserMsg = (
        result.current.runtime.messages as Array<{
          role: string;
          metadata?: { custom?: { status?: string } };
        }>
      ).find((m) => m.role === "user");
      expect(historyUserMsg).toBeDefined();
      // History messages have no status (server payload didn't include one),
      // and crucially they did NOT transition to "failed".
      expect(historyUserMsg!.metadata?.custom?.status).not.toBe("failed");
    });

    it("isOrphaned is false when assistant has responded", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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
      const messages = result.current.runtime.messages as Array<{
        role: string;
        id: string;
        content: Array<{ type: string; text: string }>;
        metadata?: {
          custom?: { syntheticOrphanError?: boolean; retryable?: boolean; retryReason?: string };
        };
      }>;
      const lastMsg = messages[messages.length - 1];
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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
        result.current.runtime.onNew(makeUserMessage("retry"));
      });

      expect(result.current.isOrphaned).toBe(false);
      // No synthetic bubble in thread messages
      const messages = result.current.runtime.messages as Array<{
        metadata?: { custom?: { syntheticOrphanError?: boolean } };
      }>;
      const hasSyntheticBubble = messages.some(
        (m) => m.metadata?.custom?.syntheticOrphanError === true
      );
      expect(hasSyntheticBubble).toBe(false);
    });
  });

  // ── ack timeout ─────────────────────────────────────────────────────────────
  describe("ack timeout", () => {
    it("transitions message to failed after 10s without ack", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      const ws = latestWs();
      const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
        clientMessageId: string;
      };

      // Advance 10 seconds — ack timer fires, message must transition to "failed".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      const failedMsg = (
        result.current.runtime.messages as Array<{
          id?: string;
          role: string;
          metadata?: { custom?: { status?: string } };
        }>
      ).find((m) => m.role === "user" && m.id === sentPayload.clientMessageId);
      expect(failedMsg?.metadata?.custom?.status).toBe("failed");
    });

    it("does NOT fail message if ack arrives before 10s", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      const ws = latestWs();
      const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
        clientMessageId: string;
      };

      // Ack arrives before the 10s timer fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await act(async () => {
        ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      });

      // Advance past the original 10s window — timer must NOT flip status now.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      const sentMsg = (
        result.current.runtime.messages as Array<{
          id?: string;
          role: string;
          metadata?: { custom?: { status?: string } };
        }>
      ).find((m) => m.role === "user" && m.id === sentPayload.clientMessageId);
      expect(sentMsg?.metadata?.custom?.status).toBe("sent");
    });

    it("late ack after failed transition is discarded", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      const ws = latestWs();
      const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
        clientMessageId: string;
      };

      // Timer fires — message → "failed".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      // Late ack arrives after the failure. Reducer must ignore it.
      await act(async () => {
        ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
        ws.simulateMessage({ type: "complete" });
      });

      const lateMsg = (
        result.current.runtime.messages as Array<{
          id?: string;
          role: string;
          metadata?: { custom?: { status?: string } };
        }>
      ).find((m) => m.role === "user" && m.id === sentPayload.clientMessageId);
      expect(lateMsg?.metadata?.custom?.status).toBe("failed");
    });
  });

  // ── isRunning resets to false after every terminal path ─────────────────────
  describe("isRunning resets to false after every terminal path", () => {
    it("resets after assistant stream completes (complete frame)", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
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
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
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

  // ── injected error bubbles have retryable: true ─────────────────────────────
  describe("injected error bubbles have retryable: true", () => {
    it("disconnect error bubble has retryReason 'send_failure' when no chunks were received", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      // WS dies BEFORE any chunk arrives — no last turn to continue, must resend.
      await act(async () => {
        latestWs().simulateClose();
      });

      // Disconnect bubble is now deferred 2s — give a successful reconnect a
      // chance to land first (issue #199). Advance past the grace window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(result.current.isRunning).toBe(false);

      const messages = result.current.runtime.messages as Array<{
        role: string;
        metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
      }>;
      const lastMsg = messages[messages.length - 1];
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
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      // Start a stream (chunk arrives) then WS disconnects
      await act(async () => {
        latestWs().simulateMessage({ type: "chunk", messageId: "m1", content: "Partial..." });
      });

      await act(async () => {
        latestWs().simulateClose();
      });

      // Disconnect bubble is now deferred 2s — give a successful reconnect a
      // chance to land first (issue #199). Advance past the grace window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      // isRunning should have been true, so a disconnect error bubble was injected
      expect(result.current.isRunning).toBe(false);

      const messages = result.current.runtime.messages as Array<{
        role: string;
        metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
      }>;
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
      expect(lastMsg.metadata?.custom?.retryable).toBe(true);
      expect(lastMsg.metadata?.custom?.retryReason).toBe("partial_stream_failure");
    });

    it("stuck timeout error bubble has retryable: true in metadata", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      expect(result.current.isRunning).toBe(true);

      // Advance 60 seconds — stuck timer fires
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(result.current.isRunning).toBe(false);

      const messages = result.current.runtime.messages as Array<{
        role: string;
        metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
      }>;
      const lastMsg = messages[messages.length - 1];
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
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      expect(result.current.isRunning).toBe(true);

      // Error arrives BEFORE any assistant chunks — there is no "last turn" to
      // continue, so retry must resend the original message instead.
      await act(async () => {
        latestWs().simulateMessage({ type: "error", message: "Something went wrong" });
      });

      expect(result.current.isRunning).toBe(false);

      const messages = result.current.runtime.messages as Array<{
        role: string;
        metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
      }>;
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
      expect(lastMsg.metadata?.custom?.retryable).toBe(true);
      expect(lastMsg.metadata?.custom?.retryReason).toBe("send_failure");
    });

    it("does not wipe completed conversation on reconnect when server returns empty history", async () => {
      // Common case: OpenClaw is down. Browser reconnects to Pinchy, requests
      // history, server can't reach OpenClaw → returns empty. We must keep what
      // the user already has on screen instead of replacing with empty.
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Build a completed turn: user → ack → assistant chunk → complete
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
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

      const beforeDisconnect = (result.current.runtime.messages as Array<{ role: string }>).length;
      expect(beforeDisconnect).toBeGreaterThanOrEqual(2);

      // Disconnect (no stream in progress, no error bubble injected)
      await act(async () => {
        ws.simulateClose();
      });

      // Reconnect with empty history (because upstream OpenClaw is unreachable).
      // The auto-reconnect uses a 1s backoff for the first attempt — advance
      // past it so the new WebSocket is created.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Messages from before the disconnect must still be present
      const messages = result.current.runtime.messages as Array<{ role: string }>;
      const userMessages = messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(1);
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    });

    it("does not wipe local state on reconnect when last message is the disconnect error bubble", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // Open WS, load empty history
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Send a message and receive a partial chunk
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      const ws = latestWs();
      const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
        clientMessageId: string;
      };
      await act(async () => {
        ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
        ws.simulateMessage({ type: "chunk", messageId: "asst-1", content: "Partial " });
      });

      // Simulate disconnect — arms reconcile, schedules deferred error bubble
      await act(async () => {
        ws.simulateClose();
      });

      // Reconnect with EMPTY history before the deferral fires — empty history
      // can't be canonical, so the local state stays. The deferred bubble timer
      // is NOT cancelled (only non-empty history cancels it), so advancing past
      // the grace window surfaces the bubble.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000); // backoff for reconnect
      });
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Advance past the disconnect-bubble grace window (issue #199).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      const messages = result.current.runtime.messages as Array<{
        role: string;
        metadata?: { custom?: { error?: unknown } };
      }>;
      expect(messages.length).toBeGreaterThanOrEqual(3); // user + partial assistant + error

      // Local state must be preserved — empty server history can't be canonical
      // when we still have unpersisted local state ending in an error bubble.
      const errorBubbles = messages.filter(
        (m) => m.role === "assistant" && m.metadata?.custom?.error
      );
      expect(errorBubbles).toHaveLength(1);

      // The user message must still be there
      const userMessages = messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(1);
    });

    it("removes the previous partial assistant response when the retry's first chunk arrives", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("write a story"));
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
        (result.current.runtime.messages as Array<{ role: string }>).filter(
          (m) => m.role === "assistant"
        )
      ).toHaveLength(2);

      await act(async () => {
        result.current.onRetryContinue("partial_stream_failure");
      });
      await act(async () => {
        ws.simulateMessage({ type: "chunk", messageId: "asst-new", content: "Once upon" });
      });

      // After the retry's first chunk: only user + new assistant remain.
      // The previous partial response and the error bubble are both gone.
      const finalMessages = result.current.runtime.messages as Array<{ role: string }>;
      expect(finalMessages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(finalMessages.filter((m) => m.role === "assistant")).toHaveLength(1);
    });

    it("error bubble is auto-dismissed when a successful chunk arrives", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      const ws = latestWs();
      await act(async () => {
        ws.simulateMessage({ type: "error", message: "Agent runtime not available" });
      });

      // Confirm the error bubble exists at this point
      const beforeRetry = (
        result.current.runtime.messages as Array<{
          role: string;
          metadata?: { custom?: { error?: unknown } };
        }>
      ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
      expect(beforeRetry).toHaveLength(1);

      // Simulate a successful retry: chunk arrives
      await act(async () => {
        ws.simulateMessage({ type: "chunk", messageId: "asst-success", content: "Hello!" });
      });

      // Error bubble must be gone — only the successful assistant chunk remains
      const afterChunk = (
        result.current.runtime.messages as Array<{
          role: string;
          metadata?: { custom?: { error?: unknown } };
        }>
      ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
      expect(afterChunk).toHaveLength(0);
    });

    it("a new error bubble replaces the previous one — no stacking", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello"));
      });

      const ws = latestWs();
      await act(async () => {
        ws.simulateMessage({ type: "error", message: "First error" });
      });

      // After first error: 1 user message + 1 error bubble = 2 messages
      const errorBubblesAfterFirst = (
        result.current.runtime.messages as Array<{
          role: string;
          metadata?: { custom?: { error?: unknown } };
        }>
      ).filter((m) => m.role === "assistant" && m.metadata?.custom?.error);
      expect(errorBubblesAfterFirst).toHaveLength(1);

      // Simulate another send + error (e.g. user retried, server failed again)
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("retry attempt"));
      });
      await act(async () => {
        ws.simulateMessage({ type: "error", message: "Second error" });
      });

      // Only ONE error bubble must exist — the new one replaced the old one
      const errorBubblesAfterSecond = (
        result.current.runtime.messages as Array<{
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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

      const messages = result.current.runtime.messages as Array<{
        role: string;
        metadata?: { custom?: { retryable?: boolean; retryReason?: string } };
      }>;
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
      expect(lastMsg.metadata?.custom?.retryable).toBe(true);
      expect(lastMsg.metadata?.custom?.retryReason).toBe("partial_stream_failure");
    });
  });

  // ── openclaw_status frame ───────────────────────────────────────────────────
  describe("openclaw_status frame", () => {
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

  // ── onRetryContinue ─────────────────────────────────────────────────────────
  describe("onRetryContinue", () => {
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
        result.current.runtime.onNew(makeUserMessage("hello world"));
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
        result.current.runtime.onNew(makeUserMessage("write a story"));
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
        result.current.runtime.onNew(makeUserMessage("are you there?"));
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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

  // ── onRetryResend ───────────────────────────────────────────────────────────
  describe("onRetryResend", () => {
    it("flips failed message status to sending and re-sends the WS frame", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Send a user message
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello retry"));
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

      // Verify message is now "failed" by checking the metadata.custom.status
      const failedMsg = (result.current.runtime.messages as Array<unknown>).find((m) => {
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
      const retriedMsg = (result.current.runtime.messages as Array<unknown>).find((m) => {
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
        result.current.runtime.onNew(makeUserMessage("hello"));
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
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello retry running"));
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

    // "preserves image attachments when retrying" was removed together with
    // the legacy base64-over-WS flow. The two-phase upload pipeline doesn't
    // round-trip attachmentIds on retry (they materialize at send time and
    // the row is already in `attached` state). Retry just re-sends text.
    // See src/__tests__/hooks/use-pending-uploads.test.ts for the new shape.

    it("restarts the 10s ack timer after retry", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("timer test"));
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
      const failedMsg = (result.current.runtime.messages as Array<unknown>).find((m) => {
        const msg = m as { id?: string; metadata?: { custom?: { status?: string } } };
        return msg.id === messageId && msg.metadata?.custom?.status === "failed";
      });
      expect(failedMsg).toBeDefined();
    });
  });

  // ── history reconcile on reconnect ──────────────────────────────────────────
  describe("history reconcile on reconnect", () => {
    it("upgrades in-flight sending messages to sent when they appear in reloaded history", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // Connect and load initial empty history
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Send a user message — it will have status "sending"
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("hello from user"));
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
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // Connect and load initial empty history
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Send a user message — it will have status "sending"
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("persisted message"));
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
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // Connect and load initial empty history
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // Send a user message — it will have status "sending"
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("lost message"));
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

    // Issue #310: production users saw "The agent didn't respond" even though
    // the assistant reply had landed safely on OpenClaw. Root cause: the WS
    // dropped between ack and the first chunk, so the last non-error local
    // message was the user's send. The reconcile gate at use-ws-runtime.ts
    // required `lastNonError.role === "assistant"`, which fails in this
    // window — server history was ignored and the orphan stuck around.
    it("reconciles from history when WS dropped before any assistant chunk arrived (#310)", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // Connect, load empty history
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // User sends; receive ack but NO chunk yet
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("what's the vacation policy?"));
      });
      const ws = latestWs();
      const sentPayload = JSON.parse(ws.send.mock.calls.at(-1)![0] as string) as {
        clientMessageId: string;
      };
      await act(async () => {
        ws.simulateMessage({ type: "ack", clientMessageId: sentPayload.clientMessageId });
      });

      // WS drops BEFORE any assistant chunk arrives
      await act(async () => {
        ws.simulateClose();
      });

      // Reconnect after backoff — OpenClaw completed the turn while we were
      // gone, so server history contains the full user + assistant pair.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({
          type: "history",
          messages: [
            { role: "user", content: "what's the vacation policy?", timestamp: 1000 },
            { role: "assistant", content: "25 days of paid leave per year.", timestamp: 2000 },
          ],
        });
      });

      // Advance past the disconnect-bubble grace window — bubble must stay
      // cancelled because reconcile landed within the window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // Flush the staged-replace timer (stageDestructiveHistoryReconcile uses
      // a 0ms setTimeout to remount the message subtree before swapping).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      const messages = result.current.runtime.messages as Array<{
        role: string;
        content: Array<{ text: string }>;
        metadata?: { custom?: { error?: unknown } };
      }>;

      // No synthetic disconnect bubble — reconcile happened in time
      const errorBubbles = messages.filter(
        (m) => m.role === "assistant" && m.metadata?.custom?.error
      );
      expect(errorBubbles).toHaveLength(0);

      // Canonical assistant reply must be the last message
      expect(messages.at(-1)?.role).toBe("assistant");
      expect(messages.at(-1)?.content[0].text).toBe("25 days of paid leave per year.");

      // isOrphaned must be false — the orphan was healed via reconcile
      expect(result.current.isOrphaned).toBe(false);
    });

    describe("binary file attachments (PDF)", () => {
      // The legacy "PDF carried as image_url in WS content" tests were retired
      // together with the base64-over-WS flow. Equivalent coverage now lives
      // in src/__tests__/hooks/use-pending-uploads.test.ts (attachmentIds in
      // the WS payload), src/__tests__/api/uploads-post.integration.test.ts
      // (server-side size/MIME rejection with 413 / 415) and
      // e2e/integration/upload-and-send.spec.ts (full round-trip).

      it("renders the chip on a user message loaded from history (files field round-tripped)", async () => {
        // Reload regression: PDF chip survived the fresh-send path (PR #316 review
        // fix) but disappeared on page reload because the server's history payload
        // didn't carry file metadata. With the in-message <pinchy:attachments>
        // block the server now parses out the file refs and surfaces them as a
        // `files` field on each history user message — the hook must convert
        // those into a `file` content part so the chip renders identically to
        // the fresh-send path.
        const { result } = renderHook(() => useWsRuntime("agent-1"));
        await act(async () => {
          latestWs().simulateOpen();
          latestWs().simulateMessage({
            type: "history",
            messages: [
              {
                role: "user",
                content: "Was steht in dieser Datei?",
                files: [{ filename: "invoice.pdf", mimeType: "application/pdf" }],
                timestamp: 1708460000000,
              },
            ],
          });
        });

        const userMsg = (
          result.current.runtime.messages as Array<{
            role: string;
            content: Array<{ type: string; filename?: string; mimeType?: string; text?: string }>;
          }>
        ).find((m) => m.role === "user");
        expect(userMsg).toBeDefined();
        // Text content must be the user's typed text — without the markup block.
        const textPart = userMsg!.content.find((p) => p.type === "text");
        expect(textPart?.text).toBe("Was steht in dieser Datei?");
        // File chip must be rendered from the round-tripped files field.
        const filePart = userMsg!.content.find((p) => p.type === "file");
        expect(filePart).toBeDefined();
        expect(filePart!.filename).toBe("invoice.pdf");
        expect(filePart!.mimeType).toBe("application/pdf");
      });

      it("renders an image preview on a user message loaded from history (image/png)", async () => {
        const { result } = renderHook(() => useWsRuntime("agent-1"));
        await act(async () => {
          latestWs().simulateOpen();
          latestWs().simulateMessage({
            type: "history",
            messages: [
              {
                role: "user",
                content: "Hier ein Foto",
                files: [{ filename: "selfie.jpg", mimeType: "image/jpeg" }],
                timestamp: 1708460000000,
              },
            ],
          });
        });
        const userMsg = (
          result.current.runtime.messages as Array<{
            role: string;
            content: Array<{ type: string; mimeType?: string; filename?: string }>;
          }>
        ).find((m) => m.role === "user");
        expect(userMsg).toBeDefined();
        const filePart = userMsg!.content.find((p) => p.type === "file");
        expect(filePart?.mimeType).toBe("image/jpeg");
        expect(filePart?.filename).toBe("selfie.jpg");
      });
    });
  });

  // ── #310 Tier 2b: server-correlated resume across reconnect ──────────────
  describe("#310 Tier 2b activeRun resume + pre-history buffer", () => {
    it("buffers a chunk that arrives BEFORE the history frame and drains it after reconcile (race window)", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // Initial connect + history land normally.
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // User sends a message → reaches "sending" status.
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("what's the policy?"));
      });

      // Drop the connection mid-stream — server-side OC continues but
      // the new ws will arm the pre-history buffer.
      await act(async () => {
        latestWs().simulateClose(1006);
        // Backoff timer is fake — fast-forward past it so reconnect fires.
        vi.advanceTimersByTime(1200);
      });

      const ws2 = latestWs();
      await act(async () => {
        ws2.simulateOpen();
        // The server's `addListener` runs synchronously in handleHistory
        // and a chunk arrives BEFORE the history response — simulate
        // exactly that ordering.
        ws2.simulateMessage({
          type: "chunk",
          content: "25 days vacation.",
          messageId: "msg-server-1",
        });
      });

      // At this point the chunk MUST NOT have been applied — no assistant
      // message carries "25 days vacation." yet. (The empty in-flight
      // placeholder from the send path is allowed to exist; only the chunk
      // CONTENT must still be absent.)
      const midwayMessages = result.current.runtime.messages;
      const appliedBefore = (midwayMessages as Array<{ role: string; content: unknown }>).find(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes("25 days vacation.")
      );
      expect(appliedBefore).toBeUndefined();

      // Now the history frame arrives with an activeRun signal pinning
      // the in-flight assistant turn to the same messageId the chunk
      // used. Drain should apply the buffered chunk to that anchored
      // message.
      await act(async () => {
        ws2.simulateMessage({
          type: "history",
          messages: [
            { role: "user", content: "what's the policy?", timestamp: 1000 },
            { role: "assistant", content: "", timestamp: 2000 },
          ],
          activeRun: { runId: "run-1", messageId: "msg-server-1", startedAt: 1500 },
        });
      });

      // After drain, the assistant message anchored to msg-server-1 has
      // received the chunk's content.
      const afterMessages = result.current.runtime.messages as Array<{
        role: string;
        content: unknown;
      }>;
      const assistantAfter = afterMessages.find((m) => m.role === "assistant");
      expect(assistantAfter).toBeDefined();
      // assistant-ui content shape: array of parts. We expect the chunk
      // text inside.
      const flat = JSON.stringify(assistantAfter!.content);
      expect(flat).toContain("25 days vacation.");
      // isRunning preserved across reconnect via the activeRun signal.
      expect(result.current.runtime.isRunning).toBe(true);
    });

    it("does NOT buffer chunks on the very first connect (no recovery context, no race window)", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // First connect — buffer should NOT be armed.
      await act(async () => {
        latestWs().simulateOpen();
        // A chunk that arrives before history (atypical but possible if
        // tests/mocks send it) is processed immediately — no buffer.
        latestWs().simulateMessage({
          type: "chunk",
          content: "Immediate hello",
          messageId: "msg-init-1",
        });
        latestWs().simulateMessage({ type: "history", messages: [] });
      });

      // The chunk was applied (not buffered then drained — that's still
      // visible to the user the same way, but observably isRunning
      // transitions immediately rather than only after history).
      expect(result.current.runtime.isRunning).toBe(true);
    });

    // PR #442 review fix: when shouldStageReplace would normally fire (local
    // has an error bubble that history doesn't contain), the staged path
    // uses setTimeout(0) to remount the message subtree. drainBuffer fires
    // synchronously, so without the `!activeRun` guard the buffered chunks
    // would apply to stale state and then be wiped by the deferred stage.
    // The fix: when activeRun is present, take the synchronous setMessages
    // path so the drain sees the reconciled state.
    it("preserves buffered chunks across error-then-retry-then-disconnect (skips destructive stage when activeRun is present)", async () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));

      // Initial connect + history with a completed first turn.
      await act(async () => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({
          type: "history",
          messages: [
            { role: "user", content: "first question", timestamp: 1000 },
            { role: "assistant", content: "first answer", timestamp: 2000 },
          ],
        });
      });

      // Synthetic disconnect error from a prior turn.
      await act(async () => {
        latestWs().simulateMessage({
          type: "error",
          providerError: "Connection interrupted",
          agentName: "Smithers",
          messageId: "msg-errored-turn",
        });
      });

      // User retries.
      await act(async () => {
        result.current.runtime.onNew(makeUserMessage("retry"));
      });

      // WS drops mid-stream — server-side OC continues.
      await act(async () => {
        latestWs().simulateClose(1006);
        vi.advanceTimersByTime(1200);
      });

      // Reconnect. A chunk for the in-flight turn arrives BEFORE history.
      const ws2 = latestWs();
      await act(async () => {
        ws2.simulateOpen();
        ws2.simulateMessage({
          type: "chunk",
          content: "retry-answer",
          messageId: "msg-retry-turn",
        });
      });

      // History arrives. The local list still has the error bubble +
      // possibly mismatches length, which would normally trigger the
      // destructive staged remount. With activeRun present, we take the
      // synchronous path so the drained chunk lands on reconciled state.
      await act(async () => {
        ws2.simulateMessage({
          type: "history",
          messages: [
            { role: "user", content: "first question", timestamp: 1000 },
            { role: "assistant", content: "first answer", timestamp: 2000 },
            { role: "user", content: "retry", timestamp: 3000 },
            { role: "assistant", content: "", timestamp: 4000 },
          ],
          activeRun: { runId: "run-retry", messageId: "msg-retry-turn", startedAt: 4000 },
        });
      });

      // The buffered chunk's text must be present in the in-flight assistant
      // message — proving drain landed on the post-reconcile state, not the
      // pre-stage state that the staged path would have wiped.
      const messages = result.current.runtime.messages as Array<{
        role: string;
        content: unknown;
      }>;
      const flat = JSON.stringify(messages);
      expect(flat).toContain("retry-answer");
      // No lingering error bubble — reconcile wiped it.
      const errorBubbles = messages.filter(
        (m) => (m as { metadata?: { custom?: { error?: unknown } } }).metadata?.custom?.error
      );
      expect(errorBubbles).toHaveLength(0);
    });
  });
});

// ── Two-phase upload send path (attachmentIds) ────────────────────────────────

import * as uploadModule from "@/lib/upload-attachment";

const localStorageStore: Record<string, string> = {};

describe("Two-phase upload: attachmentIds in WS payload", () => {
  let spyCreateObjectURL: ReturnType<typeof vi.spyOn>;
  let spyRevokeObjectURL: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
    // Re-stub WebSocket each time since afterEach calls vi.unstubAllGlobals()
    vi.stubGlobal("WebSocket", MockWebSocket);
    spyCreateObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    spyRevokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => localStorageStore[key] ?? null,
      setItem: (key: string, value: string) => {
        localStorageStore[key] = value;
      },
      removeItem: (key: string) => {
        delete localStorageStore[key];
      },
      clear: () => {
        Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
      },
    });
    Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  });

  afterEach(() => {
    vi.useRealTimers();
    spyCreateObjectURL.mockRestore();
    spyRevokeObjectURL.mockRestore();
    vi.unstubAllGlobals();
  });

  it("includes attachmentIds from ready pendingUploads in the WS payload", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockResolvedValue({
      id: "upload-id-1",
      filename: "test.pdf",
    });

    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    // Add a file via addPendingUpload and wait for it to reach "ready"
    await act(async () => {
      result.current.addPendingUpload(new File(["data"], "test.pdf", { type: "application/pdf" }));
    });

    expect(result.current.pendingUploads[0]?.state).toBe("ready");

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "see this" }],
        parentId: "root",
      });
    });

    // calls[0] is the history request, calls[1] is the user message
    const sentMessage = JSON.parse(ws.send.mock.calls[1][0]);
    expect(sentMessage.type).toBe("message");
    expect(sentMessage.attachmentIds).toEqual(["upload-id-1"]);
  });

  it("clears ready pendingUploads after send", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockResolvedValue({
      id: "upload-id-2",
      filename: "doc.pdf",
    });

    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    await act(async () => {
      result.current.addPendingUpload(new File(["data"], "doc.pdf", { type: "application/pdf" }));
    });

    expect(result.current.pendingUploads).toHaveLength(1);

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "send it" }],
        parentId: "root",
      });
    });

    expect(result.current.pendingUploads).toHaveLength(0);
  });

  it("does not send when only uploading (not ready) uploads exist and text is empty", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    // calls[0] is the history request — clear it
    ws.send.mockClear();

    await act(async () => {
      result.current.addPendingUpload(new File(["data"], "doc.pdf", { type: "application/pdf" }));
    });

    // File is still "uploading" (promise never resolves) — send with empty text
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "" }],
        parentId: "root",
      });
    });

    // No WS message frame should have been sent
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("PROTOCOL_OUTDATED error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
    // Re-stub WebSocket because "Two-phase upload" afterEach calls vi.unstubAllGlobals()
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows toast with reload action and stops running when PROTOCOL_OUTDATED is received", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    expect(result.current.isRunning).toBe(true);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "error", code: "PROTOCOL_OUTDATED" }),
      });
    });

    expect(result.current.isRunning).toBe(false);
    expect(mockToast).toHaveBeenCalledOnce();
    const [toastMsg, toastOpts] = mockToast.mock.calls[0] as [
      string,
      { action?: { label: string } },
    ];
    expect(toastMsg).toMatch(/reload/i);
    expect(toastOpts?.action?.label).toMatch(/reload/i);
  });

  it("does NOT add PROTOCOL_OUTDATED to the message list", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    const messagesBefore = result.current.runtime.messages.length;

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "error", code: "PROTOCOL_OUTDATED" }),
      });
    });

    expect(result.current.runtime.messages).toHaveLength(messagesBefore);
  });
});
