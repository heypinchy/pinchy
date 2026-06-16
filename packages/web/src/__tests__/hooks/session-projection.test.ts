import { describe, it, expect } from "vitest";
import {
  applyMessageSnapshot,
  applyTextDelta,
  type ProjectedMessage,
} from "@/hooks/session-projection";

describe("applyMessageSnapshot", () => {
  it("is idempotent — applying the same snapshot twice yields an equal list", () => {
    const snapshot = { seq: 1, role: "user" as const, content: "hi" };
    const once = applyMessageSnapshot([], snapshot);
    const twice = applyMessageSnapshot(once, snapshot);
    expect(twice).toEqual(once);
    expect(twice).toHaveLength(1);
  });

  it("inserts out-of-order snapshots keeping ascending seq order", () => {
    const afterThree = applyMessageSnapshot([], {
      seq: 3,
      role: "assistant" as const,
      content: "third",
    });
    const afterOne = applyMessageSnapshot(afterThree, {
      seq: 1,
      role: "user" as const,
      content: "first",
    });
    expect(afterOne.map((m) => m.seq)).toEqual([1, 3]);
    expect(afterOne.map((m) => m.content)).toEqual(["first", "third"]);
  });

  it("inserts a middle snapshot in the right position", () => {
    let messages: ProjectedMessage[] = [];
    messages = applyMessageSnapshot(messages, { seq: 1, role: "user", content: "a" });
    messages = applyMessageSnapshot(messages, { seq: 5, role: "assistant", content: "c" });
    messages = applyMessageSnapshot(messages, { seq: 3, role: "user", content: "b" });
    expect(messages.map((m) => m.seq)).toEqual([1, 3, 5]);
  });

  it("replaces an existing snapshot in place, updating content but preserving its id", () => {
    const first = applyMessageSnapshot([], {
      seq: 2,
      role: "assistant" as const,
      content: "partial",
    });
    const originalId = first[0].id;
    const updated = applyMessageSnapshot(first, {
      seq: 2,
      role: "assistant" as const,
      content: "complete answer",
    });
    expect(updated).toHaveLength(1);
    expect(updated[0].content).toBe("complete answer");
    expect(updated[0].id).toBe(originalId);
  });

  it("does not mutate the input array", () => {
    const messages: ProjectedMessage[] = [];
    const result = applyMessageSnapshot(messages, { seq: 1, role: "user", content: "hi" });
    expect(messages).toHaveLength(0);
    expect(result).not.toBe(messages);
  });

  it("carries optional fields (files, timestamp) onto the projected message", () => {
    const result = applyMessageSnapshot([], {
      seq: 1,
      role: "user" as const,
      content: "see attached",
      files: [{ filename: "report.pdf", mimeType: "application/pdf" }],
      timestamp: "2026-06-16T00:00:00.000Z",
    });
    expect(result[0].files).toEqual([{ filename: "report.pdf", mimeType: "application/pdf" }]);
    expect(result[0].timestamp).toBe("2026-06-16T00:00:00.000Z");
  });
});

describe("applyTextDelta", () => {
  it("appends delta text to the existing message with that seq", () => {
    const seeded = applyMessageSnapshot([], {
      seq: 1,
      role: "assistant" as const,
      content: "Hel",
    });
    const out = applyTextDelta(seeded, { seq: 1, text: "lo" });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("Hello");
    expect(out[0].id).toBe(seeded[0].id);
  });

  it("replaces content when replace is true", () => {
    const seeded = applyMessageSnapshot([], {
      seq: 1,
      role: "assistant" as const,
      content: "stale partial",
    });
    const out = applyTextDelta(seeded, { seq: 1, text: "fresh", replace: true });
    expect(out[0].content).toBe("fresh");
    expect(out[0].id).toBe(seeded[0].id);
  });

  it("creates a new assistant message in seq order when the delta arrives before any snapshot", () => {
    const seeded = applyMessageSnapshot([], {
      seq: 1,
      role: "user" as const,
      content: "question",
    });
    const out = applyTextDelta(seeded, { seq: 2, text: "answering" });
    expect(out.map((m) => m.seq)).toEqual([1, 2]);
    expect(out[1]).toMatchObject({ seq: 2, role: "assistant", content: "answering" });
    expect(out[1].id).toBeTruthy();
  });

  it("inserts a created delta message in ascending seq position", () => {
    let messages: ProjectedMessage[] = [];
    messages = applyMessageSnapshot(messages, { seq: 1, role: "user", content: "a" });
    messages = applyMessageSnapshot(messages, { seq: 5, role: "assistant", content: "c" });
    messages = applyTextDelta(messages, { seq: 3, text: "b" });
    expect(messages.map((m) => m.seq)).toEqual([1, 3, 5]);
  });

  it("updates the same message on a duplicate-seq delta — no duplicate row", () => {
    let messages = applyTextDelta([], { seq: 2, text: "one " });
    messages = applyTextDelta(messages, { seq: 2, text: "two" });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("one two");
    expect(messages.filter((m) => m.seq === 2)).toHaveLength(1);
  });

  it("does not mutate the input array", () => {
    const seeded = applyMessageSnapshot([], {
      seq: 1,
      role: "assistant" as const,
      content: "x",
    });
    const out = applyTextDelta(seeded, { seq: 1, text: "y" });
    expect(seeded[0].content).toBe("x");
    expect(out).not.toBe(seeded);
  });
});
