import { describe, it, expect, beforeEach } from "vitest";
import { getDraft, saveDraft, clearDraft } from "@/lib/draft-store";

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
