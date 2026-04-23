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
});
