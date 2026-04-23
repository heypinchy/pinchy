import { describe, it, expect } from "vitest";
import { reduceMessages } from "../message-status-reducer";

describe("reduceMessages", () => {
  it("appends a user message in 'sending' state", () => {
    const next = reduceMessages([], {
      type: "user-send",
      message: { id: "1", role: "user", content: "hi", timestamp: 0 },
    });
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe("sending");
  });

  it("transitions sending → sent on matching ack", () => {
    const initial = [
      { id: "1", role: "user", content: "hi", status: "sending" as const, timestamp: 0 },
    ];
    const next = reduceMessages(initial, { type: "ack", clientMessageId: "1" });
    expect(next[0].status).toBe("sent");
  });

  it("ignores ack for unknown clientMessageId (late ack after failed)", () => {
    const initial = [
      { id: "1", role: "user", content: "hi", status: "failed" as const, timestamp: 0 },
    ];
    const next = reduceMessages(initial, { type: "ack", clientMessageId: "1" });
    expect(next[0].status).toBe("failed"); // timeout wins, late ack discarded
  });

  it("transitions sending → failed on timeout action", () => {
    const initial = [
      { id: "1", role: "user", content: "hi", status: "sending" as const, timestamp: 0 },
    ];
    const next = reduceMessages(initial, { type: "timeout", clientMessageId: "1" });
    expect(next[0].status).toBe("failed");
  });

  it("upgrades sending→sent on history reconcile when message appears in history", () => {
    const initial = [
      { id: "1", role: "user", content: "hi", status: "sending" as const, timestamp: 0 },
    ];
    const history = [{ role: "user" as const, content: "hi" }];
    const next = reduceMessages(initial, { type: "history-reconcile", history });
    expect(next[0].status).toBe("sent");
  });

  it("transitions sending→failed on history reconcile when message is absent from history", () => {
    const initial = [
      { id: "1", role: "user", content: "hi", status: "sending" as const, timestamp: 0 },
    ];
    const next = reduceMessages(initial, { type: "history-reconcile", history: [] });
    expect(next[0].status).toBe("failed");
  });

  it("retry resets failed→sending", () => {
    const initial = [
      { id: "1", role: "user", content: "hi", status: "failed" as const, timestamp: 0 },
    ];
    const next = reduceMessages(initial, { type: "retry-resend", clientMessageId: "1" });
    expect(next[0].status).toBe("sending");
  });

  it("history-reconcile leaves already-sent and failed messages unchanged", () => {
    const initial = [
      { id: "1", role: "user" as const, content: "hi", status: "sent" as const, timestamp: 0 },
      { id: "2", role: "user" as const, content: "bye", status: "failed" as const, timestamp: 1 },
      {
        id: "3",
        role: "user" as const,
        content: "retry",
        status: "sending" as const,
        timestamp: 2,
      },
    ];
    // id "3" is not in history → should become failed
    // id "1" (sent) and id "2" (failed) should be untouched
    const next = reduceMessages(initial, { type: "history-reconcile", history: [] });
    expect(next[0].status).toBe("sent");
    expect(next[1].status).toBe("failed");
    expect(next[2].status).toBe("failed"); // was sending, not in history
  });
});
