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

  it("history-reconcile prefers clientMessageId matching over content", () => {
    // A sending message whose id matches an entry in history is "sent" —
    // even if the content happens to differ (e.g. trailing whitespace
    // normalisation by OpenClaw).
    const initial = [
      {
        id: "id-A",
        role: "user" as const,
        content: "hi",
        status: "sending" as const,
        timestamp: 0,
      },
    ];
    const next = reduceMessages(initial, {
      type: "history-reconcile",
      history: [{ role: "user", content: "hi ", clientMessageId: "id-A" }],
    });
    expect(next[0].status).toBe("sent");
  });

  it("history-reconcile distinguishes duplicate-content messages via clientMessageId", () => {
    // The user typed "yes" twice. Only the first one got persisted. With
    // id-based matching the second "yes" is correctly marked failed.
    // Content-set matching (the old behaviour) would have marked both sent.
    const initial = [
      {
        id: "id-first",
        role: "user" as const,
        content: "yes",
        status: "sending" as const,
        timestamp: 0,
      },
      {
        id: "id-second",
        role: "user" as const,
        content: "yes",
        status: "sending" as const,
        timestamp: 1,
      },
    ];
    const next = reduceMessages(initial, {
      type: "history-reconcile",
      history: [{ role: "user", content: "yes", clientMessageId: "id-first" }],
    });
    expect(next[0].status).toBe("sent");
    expect(next[1].status).toBe("failed");
  });

  it("history-reconcile falls back to content matching when no history entry carries a clientMessageId", () => {
    // Older OpenClaw sessions (pre-0.5) don't persist clientMessageId. The
    // reducer must still reconcile correctly — at the cost of the known
    // duplicate-content limitation documented on the fallback path.
    const initial = [
      {
        id: "local-id",
        role: "user" as const,
        content: "hello",
        status: "sending" as const,
        timestamp: 0,
      },
    ];
    const next = reduceMessages(initial, {
      type: "history-reconcile",
      history: [{ role: "user", content: "hello" /* no clientMessageId */ }],
    });
    expect(next[0].status).toBe("sent");
  });

  it("history-reconcile fails the message when id is absent AND content doesn't match (fallback path)", () => {
    const initial = [
      {
        id: "local-id",
        role: "user" as const,
        content: "lost message",
        status: "sending" as const,
        timestamp: 0,
      },
    ];
    const next = reduceMessages(initial, {
      type: "history-reconcile",
      history: [{ role: "user", content: "something else" }],
    });
    expect(next[0].status).toBe("failed");
  });
});
