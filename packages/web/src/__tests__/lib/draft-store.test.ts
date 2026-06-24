import { describe, it, expect, beforeEach } from "vitest";
import { getDraft, saveDraft, clearDraft, draftKey } from "@/lib/draft-store";

describe("draftKey", () => {
  it("scopes a draft to a single (agent, chat) pair", () => {
    // The bare agentId is the key for the default/legacy chat (chatId omitted)
    // — byte-identical to the pre-per-chat key so existing drafts don't move.
    expect(draftKey("agent-1")).toBe("agent-1");
    expect(draftKey("agent-1", "chat-a")).toBe("agent-1:chat-a");
  });

  it("never collides across chats of the same agent", () => {
    expect(draftKey("agent-1", "chat-a")).not.toBe(draftKey("agent-1", "chat-b"));
    // The default chat key can't collide with a per-chat key (segment count).
    expect(draftKey("agent-1")).not.toBe(draftKey("agent-1", "chat-a"));
  });

  it("isolates drafts between two chats of the same agent (the bleed bug)", () => {
    saveDraft(draftKey("agent-1", "chat-a"), { text: "draft A", files: [] });
    saveDraft(draftKey("agent-1", "chat-b"), { text: "draft B", files: [] });

    expect(getDraft(draftKey("agent-1", "chat-a"))?.text).toBe("draft A");
    expect(getDraft(draftKey("agent-1", "chat-b"))?.text).toBe("draft B");
    // The default chat of the same agent stays empty — no bleed from a sibling.
    expect(getDraft(draftKey("agent-1"))).toBeUndefined();

    clearDraft(draftKey("agent-1", "chat-a"));
    clearDraft(draftKey("agent-1", "chat-b"));
  });
});

describe("draft-store", () => {
  beforeEach(() => {
    clearDraft("agent-1");
    clearDraft("agent-2");
  });

  it("should return undefined for unknown agent", () => {
    expect(getDraft("unknown")).toBeUndefined();
  });

  it("should save and retrieve a text draft", () => {
    saveDraft("agent-1", { text: "hello", files: [] });
    expect(getDraft("agent-1")).toEqual({ text: "hello", files: [] });
  });

  it("should save drafts independently per agent", () => {
    saveDraft("agent-1", { text: "draft 1", files: [] });
    saveDraft("agent-2", { text: "draft 2", files: [] });
    expect(getDraft("agent-1")?.text).toBe("draft 1");
    expect(getDraft("agent-2")?.text).toBe("draft 2");
  });

  it("should overwrite existing draft", () => {
    saveDraft("agent-1", { text: "first", files: [] });
    saveDraft("agent-1", { text: "second", files: [] });
    expect(getDraft("agent-1")?.text).toBe("second");
  });

  it("should clear a draft", () => {
    saveDraft("agent-1", { text: "hello", files: [] });
    clearDraft("agent-1");
    expect(getDraft("agent-1")).toBeUndefined();
  });

  it("should auto-clear when text and files are empty", () => {
    saveDraft("agent-1", { text: "hello", files: [] });
    saveDraft("agent-1", { text: "", files: [] });
    expect(getDraft("agent-1")).toBeUndefined();
  });

  it("should keep draft when only files are present", () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    saveDraft("agent-1", { text: "", files: [file] });
    expect(getDraft("agent-1")).toBeDefined();
    expect(getDraft("agent-1")?.files).toHaveLength(1);
  });
});
