import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime, clearSession, getSessionKey } from "@/hooks/use-ws-runtime";

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

// Mock localStorage
const localStorageStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageStore[key];
  }),
};
vi.stubGlobal("localStorage", mockLocalStorage);

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
    // Clear localStorage store
    Object.keys(localStorageStore).forEach((key) => delete localStorageStore[key]);
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

  it("should generate and store sessionKey on first message when none exists", () => {
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

    // Should have stored a sessionKey in localStorage
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      "pinchy:session:agent-1",
      expect.any(String)
    );

    // The sent message should include the sessionKey
    const sentMessage = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentMessage.sessionKey).toBeDefined();
    expect(typeof sentMessage.sessionKey).toBe("string");
    expect(sentMessage.sessionKey.length).toBeGreaterThan(0);
  });

  it("should reuse existing sessionKey from localStorage", () => {
    localStorageStore["pinchy:session:agent-1"] = "existing-session-uuid";

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

    const sentMessage = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentMessage.sessionKey).toBe("existing-session-uuid");
  });

  it("should include sessionKey in all outgoing messages", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    // Send first message
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "Hello" }],
        parentId: "root",
      });
    });

    // Complete the response so we can send another message
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "done", messageId: "msg-1" }),
      });
    });

    // Send second message
    act(() => {
      result.current.runtime.onNew({
        content: [{ type: "text", text: "How are you?" }],
        parentId: "root",
      });
    });

    const firstMessage = JSON.parse(ws.send.mock.calls[0][0]);
    const secondMessage = JSON.parse(ws.send.mock.calls[1][0]);

    // Both messages should have the same sessionKey
    expect(firstMessage.sessionKey).toBe(secondMessage.sessionKey);
  });

  it("clearSession should remove sessionKey from localStorage", () => {
    localStorageStore["pinchy:session:agent-1"] = "some-session-uuid";

    clearSession("agent-1");

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith("pinchy:session:agent-1");
  });

  it("getSessionKey should return the stored sessionKey", () => {
    localStorageStore["pinchy:session:agent-1"] = "stored-uuid";

    expect(getSessionKey("agent-1")).toBe("stored-uuid");
  });

  it("getSessionKey should return null when no sessionKey exists", () => {
    expect(getSessionKey("agent-1")).toBeNull();
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

    act(() => {
      result.current.runtime.onNew({
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", image: "data:image/png;base64,abc123" },
        ],
        parentId: "root",
      });
    });

    const sentMessage = JSON.parse(ws.send.mock.calls[0][0]);
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

    const sentMessage = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentMessage.content).toBe("Hello plain");
  });

  it("should reject image attachments larger than 5MB", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    // Create a data URL that exceeds 5MB
    const largeImage = "data:image/png;base64," + "A".repeat(5 * 1024 * 1024 + 1);

    act(() => {
      result.current.runtime.onNew({
        content: [
          { type: "text", text: "Big image" },
          { type: "image", image: largeImage },
        ],
        parentId: "root",
      });
    });

    // Should not send via WebSocket
    expect(ws.send).not.toHaveBeenCalled();

    // Should show an error message in messages
    const messages = result.current.runtime.messages;
    const errorMessage = messages.find(
      (m: any) => m.role === "assistant" && m.content[0]?.text?.includes("5MB")
    );
    expect(errorMessage).toBeDefined();
  });

  it("should store image data on user message for display", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws = wsInstances[0];

    act(() => {
      ws.onopen?.();
    });

    act(() => {
      result.current.runtime.onNew({
        content: [
          { type: "text", text: "Describe this" },
          { type: "image", image: "data:image/png;base64,xyz789" },
        ],
        parentId: "root",
      });
    });

    // The converted messages should include image content for display
    const messages = result.current.runtime.messages;
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();

    const imageContent = userMsg.content.find((c: any) => c.type === "image");
    expect(imageContent).toBeDefined();
    expect(imageContent.image).toBe("data:image/png;base64,xyz789");
  });
});
