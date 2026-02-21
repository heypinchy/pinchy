import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";

// Track all created WebSocket instances
let wsInstances: MockWebSocket[] = [];

// Mock WebSocket
class MockWebSocket {
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

  it("should stop running immediately when a done message is received", () => {
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

    // Receive done message - should immediately stop running
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "done", messageId: "msg-1" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(false);
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

    // Should show the error as an assistant message
    const messages = result.current.runtime.messages;
    const errorMsg = messages.find(
      (m: any) => m.role === "assistant" && m.content[0]?.text?.includes("Something went wrong")
    );
    expect(errorMsg).toBeDefined();
  });

  it("should clear debounce timer when done message arrives", () => {
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

    // Receive a chunk (starts debounce timer)
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "chunk",
          content: "Hi",
          messageId: "msg-1",
        }),
      });
    });

    // Receive done immediately
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "done", messageId: "msg-1" }),
      });
    });

    expect(result.current.runtime.isRunning).toBe(false);

    // Advance past debounce time - should not cause any issues
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // Still false, no double-setting
    expect(result.current.runtime.isRunning).toBe(false);
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
      custom: { timestamp: "2026-03-15T10:30:00.000Z" },
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
});
