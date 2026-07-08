import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getChatList,
  setChatList,
  hasChatList,
  prefetchChatList,
  invalidateChatList,
  __resetChatListCacheForTests,
} from "@/lib/chat-list-cache";
import type { ChatListItem } from "@/lib/schemas/sessions";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(),
}));
import { apiGet } from "@/lib/api-client";

const mockApiGet = apiGet as ReturnType<typeof vi.fn>;

const item = (chatId: string | null, title: string): ChatListItem => ({
  chatId,
  sessionId: `session-${chatId ?? "default"}`,
  title,
  origin: "web",
  lastInteractionAt: 1_700_000_000_000,
});

beforeEach(() => {
  __resetChatListCacheForTests();
  mockApiGet.mockReset();
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

describe("prefetchChatList", () => {
  it("fills the cache from the API when cold", async () => {
    mockApiGet.mockResolvedValue({ chats: [item("c1", "First")] });
    await prefetchChatList("agent-1");
    expect(mockApiGet).toHaveBeenCalledWith("/api/agents/agent-1/chats");
    expect(getChatList("agent-1")).toEqual([item("c1", "First")]);
  });

  it("is a no-op when the cache is already warm", async () => {
    setChatList("agent-1", [item("c1", "First")]);
    await prefetchChatList("agent-1");
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent in-flight prefetches", async () => {
    mockApiGet.mockReturnValue(new Promise(() => {})); // never resolves
    void prefetchChatList("agent-1");
    void prefetchChatList("agent-1");
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });

  it("leaves the cache untouched and does not throw on failure", async () => {
    mockApiGet.mockRejectedValue(new Error("boom"));
    await prefetchChatList("agent-1");
    expect(hasChatList("agent-1")).toBe(false);
  });

  it("can prefetch again after a failed attempt settles", async () => {
    mockApiGet.mockRejectedValueOnce(new Error("boom"));
    await prefetchChatList("agent-1");
    mockApiGet.mockResolvedValueOnce({ chats: [item("c1", "First")] });
    await prefetchChatList("agent-1");
    expect(getChatList("agent-1")).toEqual([item("c1", "First")]);
  });
});

describe("invalidateChatList", () => {
  it("clears the cached entry for the agent", () => {
    setChatList("agent-1", [item("c1", "First")]);
    invalidateChatList("agent-1");
    expect(hasChatList("agent-1")).toBe(false);
  });
});
