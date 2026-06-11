import { describe, it, expect } from "vitest";
import { isOrphaned } from "@/hooks/orphan-detector";

const ctx = { isRunning: false, isHistoryLoaded: true };

describe("isOrphaned", () => {
  it("detects a sent user message with no reply while idle", () => {
    expect(isOrphaned([{ id: "u1", role: "user", content: "hi", status: "sent" }], ctx)).toBe(true);
  });

  it("is false while running, before history load, or with a real reply", () => {
    const sentUser = { id: "u1", role: "user" as const, content: "hi", status: "sent" as const };
    expect(isOrphaned([sentUser], { ...ctx, isRunning: true })).toBe(false);
    expect(isOrphaned([sentUser], { ...ctx, isHistoryLoaded: false })).toBe(false);
    expect(isOrphaned([sentUser, { id: "a1", role: "assistant", content: "reply" }], ctx)).toBe(
      false
    );
  });

  it("sees through a trailing in-flight placeholder (the send-path appends one)", () => {
    // Without placeholder-transparency the detector reads the placeholder as
    // "the agent replied" and the orphan-retry bubble never appears again.
    expect(
      isOrphaned(
        [
          { id: "u1", role: "user", content: "hi", status: "sent" },
          { id: "ph", role: "assistant", content: "" },
        ],
        ctx
      )
    ).toBe(true);
  });

  it("does NOT see through a trailing empty ERROR bubble (that turn already failed visibly)", () => {
    expect(
      isOrphaned(
        [
          { id: "u1", role: "user", content: "hi", status: "sent" },
          { id: "e1", role: "assistant", content: "", error: { disconnected: true } },
        ],
        ctx
      )
    ).toBe(false);
  });
});
