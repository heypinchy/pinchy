import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";
import { useChatStatus } from "@/hooks/use-chat-status";

// Track all created WebSocket instances
let wsInstances: MockWebSocket[] = [];

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    wsInstances.push(this);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

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

  it("should register an attachment adapter with image and code file support", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const runtime = result.current.runtime;

    expect(runtime.adapters).toBeDefined();
    expect(runtime.adapters.attachments).toBeDefined();

    const acceptedTypes = runtime.adapters.attachments.accept;
    expect(acceptedTypes).toContain("image/*");
    expect(acceptedTypes).toContain("text/plain");
    expect(acceptedTypes).toContain(".ts");
    expect(acceptedTypes).toContain(".js");
    expect(acceptedTypes).toContain(".py");
  });

  it("should send structured content array when message has image attachment", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    // assistant-ui puts images in attachments, not content
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "What is this?" }],
        attachments: [
          {
            id: "img-1",
            type: "image",
            name: "photo.png",
            status: { type: "complete" },
            content: [{ type: "image", image: "data:image/png;base64,abc123" }],
          },
        ],
        parentId: "root",
      });
    });

    // calls[0] is the history request, calls[1] is the user message
    const sentMessage = JSON.parse(ws.send.mock.calls[1][0]);
    expect(sentMessage.content).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
    ]);
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

  it("should reject image attachments larger than 5MB", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    const largeImage = "data:image/png;base64," + "A".repeat(5 * 1024 * 1024 + 1);

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Big image" }],
        attachments: [
          {
            id: "img-1",
            type: "image",
            name: "big.png",
            status: { type: "complete" },
            content: [{ type: "image", image: largeImage }],
          },
        ],
        parentId: "root",
      });
    });

    // Should only have sent the history request on connect, not the user message
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sentMessage = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentMessage.type).toBe("history");

    // Should show an error message in messages
    const messages = result.current.runtime.messages;
    const errorMessage = messages.find(
      (m: any) => m.role === "assistant" && m.content[0]?.text?.includes("5MB")
    );
    expect(errorMessage).toBeDefined();
  });

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

  it("should store image data on user message for display", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Describe this" }],
        attachments: [
          {
            id: "img-1",
            type: "image",
            name: "photo.png",
            status: { type: "complete" },
            content: [{ type: "image", image: "data:image/png;base64,xyz789" }],
          },
        ],
        parentId: "root",
      });
    });

    const messages = result.current.runtime.messages;
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();

    const imageContent = userMsg.content.find((c: any) => c.type === "image");
    expect(imageContent).toBeDefined();
    expect(imageContent.image).toBe("data:image/png;base64,xyz789");
  });

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

      // User message should still appear optimistically in messages
      const messages = result.current.runtime.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content[0].text).toBe("Hello while connecting");

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
});
