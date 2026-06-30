import { describe, it, expect, beforeEach } from "vitest";
import {
  getChatList,
  setChatList,
  hasChatList,
  __resetChatListCacheForTests,
} from "@/lib/chat-list-cache";
import type { ChatListItem } from "@/lib/schemas/sessions";

const item = (chatId: string | null, title: string): ChatListItem => ({
  chatId,
  sessionId: `session-${chatId ?? "default"}`,
  title,
  origin: "web",
  lastInteractionAt: 1_700_000_000_000,
});

beforeEach(() => {
  __resetChatListCacheForTests();
});

describe("chat-list-cache", () => {
  it("returns undefined and reports no cache before any set", () => {
    expect(hasChatList("agent-1")).toBe(false);
    expect(getChatList("agent-1")).toBeUndefined();
  });

  it("stores and returns a list per agent", () => {
    setChatList("agent-1", [item("c1", "First"), item("c2", "Second")]);
    expect(hasChatList("agent-1")).toBe(true);
    expect(getChatList("agent-1")).toEqual([item("c1", "First"), item("c2", "Second")]);
  });

  it("caches agents independently", () => {
    setChatList("agent-1", [item("c1", "A1")]);
    setChatList("agent-2", [item("c2", "A2")]);
    expect(getChatList("agent-1")).toEqual([item("c1", "A1")]);
    expect(getChatList("agent-2")).toEqual([item("c2", "A2")]);
  });

  it("returns a copy so callers cannot mutate the cached list", () => {
    setChatList("agent-1", [item("c1", "First")]);
    const list = getChatList("agent-1")!;
    list.push(item("c2", "Mutated"));
    // The cached list is unaffected by the caller's mutation.
    expect(getChatList("agent-1")).toEqual([item("c1", "First")]);
  });

  it("setChatList stores a copy so the caller's array can't mutate the cache", () => {
    const original = [item("c1", "First")];
    setChatList("agent-1", original);
    original.push(item("c2", "Mutated"));
    expect(getChatList("agent-1")).toEqual([item("c1", "First")]);
  });

  it("overwrites the previous list on a subsequent set", () => {
    setChatList("agent-1", [item("c1", "First")]);
    setChatList("agent-1", [item("c2", "Second")]);
    expect(getChatList("agent-1")).toEqual([item("c2", "Second")]);
  });
});
