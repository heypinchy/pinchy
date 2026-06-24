import { describe, it, expect, beforeEach } from "vitest";
import { recordLastChat, getLastChat } from "@/lib/last-chat-store";

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
});
