// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import {
  clearChatConnection,
  publishChatConnection,
  useChatConnection,
} from "@/lib/chat-connection-store";

describe("chat connection store", () => {
  beforeEach(() => {
    clearChatConnection("agent-1");
    clearChatConnection("agent-1:chat-a");
  });

  it("reads as online and not refused for a chat nobody has published for", () => {
    const { result } = renderHook(() => useChatConnection("agent-1"));
    expect(result.current).toEqual({ isOffline: false, rejection: null });
  });

  it("returns what the runtime published, keyed by agent and chat", () => {
    const { result: plain } = renderHook(() => useChatConnection("agent-1"));
    const { result: chat } = renderHook(() => useChatConnection("agent-1", "chat-a"));
    act(() => {
      publishChatConnection("agent-1", undefined, { isOffline: true, rejection: null });
      publishChatConnection("agent-1", "chat-a", {
        isOffline: false,
        rejection: "too_many_connections",
      });
    });
    expect(plain.current).toEqual({ isOffline: true, rejection: null });
    expect(chat.current).toEqual({ isOffline: false, rejection: "too_many_connections" });
  });

  it("forgets a chat when its runtime goes away", () => {
    const { result } = renderHook(() => useChatConnection("agent-1"));
    act(() => {
      publishChatConnection("agent-1", undefined, { isOffline: true, rejection: null });
    });
    act(() => {
      clearChatConnection("agent-1");
    });
    expect(result.current).toEqual({ isOffline: false, rejection: null });
  });

  it("does not re-render subscribers for a publish that changes nothing", () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useChatConnection("agent-1");
    });
    const before = renders;
    act(() => {
      publishChatConnection("agent-1", undefined, { isOffline: false, rejection: null });
      publishChatConnection("agent-1", undefined, { isOffline: false, rejection: null });
    });
    expect(renders).toBe(before);
  });
});
