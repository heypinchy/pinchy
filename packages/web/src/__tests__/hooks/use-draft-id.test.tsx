import { renderHook } from "@testing-library/react";
import { useDraftId } from "@/hooks/use-draft-id";

describe("useDraftId", () => {
  beforeEach(() => localStorage.clear());

  it("generates a UUID on first mount and stores it", () => {
    const { result } = renderHook(() => useDraftId("agent-1"));
    expect(result.current).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem("pinchy:composer:agent-1:draftId")).toBe(result.current);
  });

  it("returns the same UUID on re-mount (localStorage persistence)", () => {
    const { result: first } = renderHook(() => useDraftId("agent-1"));
    const firstId = first.current;
    const { result: second } = renderHook(() => useDraftId("agent-1"));
    expect(second.current).toBe(firstId);
  });

  it("uses distinct IDs for different agentIds", () => {
    const { result: a } = renderHook(() => useDraftId("agent-1"));
    const { result: b } = renderHook(() => useDraftId("agent-2"));
    expect(a.current).not.toBe(b.current);
  });

  it("uses distinct IDs for different chatIds of the same agent (#508)", () => {
    // Two chats of one agent must not share a draft id, or a file staged while
    // composing in chat A would surface as a pending attachment in chat B.
    const { result: a } = renderHook(() => useDraftId("agent-1", "chat-a"));
    const { result: b } = renderHook(() => useDraftId("agent-1", "chat-b"));
    expect(a.current).not.toBe(b.current);
  });

  it("scopes the storage key by chatId; the default chat stays backward-compatible", () => {
    const { result: def } = renderHook(() => useDraftId("agent-1"));
    expect(localStorage.getItem("pinchy:composer:agent-1:draftId")).toBe(def.current);

    const { result: chat } = renderHook(() => useDraftId("agent-1", "chat-a"));
    expect(localStorage.getItem("pinchy:composer:agent-1:chat-a:draftId")).toBe(chat.current);
    expect(chat.current).not.toBe(def.current);
  });

  it("returns the same ID on re-mount for the same (agent, chat)", () => {
    const { result: first } = renderHook(() => useDraftId("agent-1", "chat-a"));
    const firstId = first.current;
    const { result: second } = renderHook(() => useDraftId("agent-1", "chat-a"));
    expect(second.current).toBe(firstId);
  });
});
