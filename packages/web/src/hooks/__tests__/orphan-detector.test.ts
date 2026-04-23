import { describe, it, expect } from "vitest";
import { isOrphaned } from "../orphan-detector";

describe("isOrphaned", () => {
  const ctx = { isRunning: false, isHistoryLoaded: true };

  it("returns true when last message is a sent user message and agent is idle", () => {
    const msgs = [{ id: "1", role: "user" as const, status: "sent" as const }];
    expect(isOrphaned(msgs, ctx)).toBe(true);
  });

  it("returns false while agent is running", () => {
    const msgs = [{ id: "1", role: "user" as const, status: "sent" as const }];
    expect(isOrphaned(msgs, { ...ctx, isRunning: true })).toBe(false);
  });

  it("returns false before history is loaded", () => {
    const msgs = [{ id: "1", role: "user" as const, status: "sent" as const }];
    expect(isOrphaned(msgs, { ...ctx, isHistoryLoaded: false })).toBe(false);
  });

  it("returns false when last message is an assistant message", () => {
    const msgs = [
      { id: "1", role: "user" as const, status: "sent" as const },
      { id: "2", role: "assistant" as const, status: undefined },
    ];
    expect(isOrphaned(msgs, ctx)).toBe(false);
  });

  it("returns false when last user message is still sending", () => {
    const msgs = [{ id: "1", role: "user" as const, status: "sending" as const }];
    expect(isOrphaned(msgs, ctx)).toBe(false);
  });

  it("returns false when messages is empty", () => {
    expect(isOrphaned([], ctx)).toBe(false);
  });

  it("returns false when user sends a new message (orphan bubble disappears)", () => {
    // After the user types and sends another message, the thread now has a
    // new user message being sent — last message is no longer the stuck sent
    // user message. isOrphaned must return false so the synthetic bubble goes away.
    const msgs = [
      { id: "1", role: "user" as const, status: "sent" as const },
      // agent never replied — then user sent a new message
      { id: "2", role: "user" as const, status: "sending" as const },
    ];
    expect(isOrphaned(msgs, ctx)).toBe(false);
  });

  it("returns false when agent finally responds to the orphaned message", () => {
    // Once an assistant message follows the stuck user message, the orphan
    // bubble must disappear.
    const msgs = [
      { id: "1", role: "user" as const, status: "sent" as const },
      { id: "2", role: "assistant" as const, status: undefined },
    ];
    expect(isOrphaned(msgs, ctx)).toBe(false);
  });
});
