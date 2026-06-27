import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordLastChat, getLastChat, subscribeLastChat } from "@/lib/last-chat-store";

describe("last-chat-store", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when no chat has been recorded for an agent", () => {
    expect(getLastChat("agent-1")).toBeNull();
  });

  it("records and returns the last viewed chat id per agent", () => {
    recordLastChat("agent-1", "chat-a");
    expect(getLastChat("agent-1")).toBe("chat-a");
  });

  it("scopes the last viewed chat per agent (no bleed across agents)", () => {
    recordLastChat("agent-1", "chat-a");
    recordLastChat("agent-2", "chat-b");
    expect(getLastChat("agent-1")).toBe("chat-a");
    expect(getLastChat("agent-2")).toBe("chat-b");
  });

  it("overwrites the previous chat when a newer one is viewed", () => {
    recordLastChat("agent-1", "chat-a");
    recordLastChat("agent-1", "chat-b");
    expect(getLastChat("agent-1")).toBe("chat-b");
  });

  it("clears the entry when the default/legacy chat is viewed (chatId null)", () => {
    // Viewing the default chat removes any stored pointer so the sidebar falls
    // back to the most-recently-interacted chat instead of pinning the default.
    recordLastChat("agent-1", "chat-a");
    recordLastChat("agent-1", null);
    expect(getLastChat("agent-1")).toBeNull();
  });

  it("treats undefined chatId the same as the default chat (clears)", () => {
    recordLastChat("agent-1", "chat-a");
    recordLastChat("agent-1", undefined);
    expect(getLastChat("agent-1")).toBeNull();
  });

  // Regression: the sidebar resolves agent links via useSyncExternalStore, which
  // only re-reads when a subscriber is notified. localStorage fires no same-tab
  // `storage` event, so without an in-module notifier the sidebar link goes stale
  // (one render behind recordLastChat's effect) and reopens an OLDER chat.
  it("notifies same-tab subscribers on record and on clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLastChat(listener);

    recordLastChat("agent-1", "chat-a");
    expect(listener).toHaveBeenCalledTimes(1);

    recordLastChat("agent-1", null);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    recordLastChat("agent-1", "chat-b");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
