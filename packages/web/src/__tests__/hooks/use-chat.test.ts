import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat } from "@/hooks/use-chat";

// Mock WebSocket
class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

vi.stubGlobal("WebSocket", MockWebSocket);

describe("useChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should start with empty messages", () => {
    const { result } = renderHook(() => useChat("agent-1"));
    expect(result.current.messages).toEqual([]);
  });

  it("should add user message on send", () => {
    const { result } = renderHook(() => useChat("agent-1"));

    act(() => {
      result.current.sendMessage("Hello");
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "Hello",
    });
  });
});
