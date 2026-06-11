/**
 * Unit tests for `shouldReplaceLocalWithServerHistory` — the decision
 * function that gates whole-list reconcile on the history frame after a
 * disconnect+reconnect cycle. The renderHook suite already exercises this
 * through the public surface; these tests pin the regression-protection
 * branches (esp. the queued-while-disconnected case) at the function level
 * so a refactor that drops the status guard fails fast and locally.
 */
import { describe, it, expect } from "vitest";
import { shouldReplaceLocalWithServerHistory, type WsMessage } from "@/hooks/use-ws-runtime";

function user(content: string, status?: "sending" | "sent" | "failed"): WsMessage {
  return { id: `u-${content}`, role: "user", content, status };
}

function assistant(content: string, opts: { error?: boolean } = {}): WsMessage {
  return {
    id: `a-${content}`,
    role: "assistant",
    content,
    ...(opts.error ? { error: { disconnected: true } } : {}),
  };
}

describe("shouldReplaceLocalWithServerHistory", () => {
  describe("in-flight placeholder transparency", () => {
    // The send path appends an empty assistant placeholder (the tab-refocus
    // crash fix). It is a client-only artifact the server never knows about —
    // the gate must behave EXACTLY as if it weren't there, otherwise the
    // trailing-assistant rule would fire `true` and bypass the #310
    // strictly-longer guard.
    it("ignores a trailing placeholder: acked user + history NOT longer → false", () => {
      expect(
        shouldReplaceLocalWithServerHistory([user("hi", "sent"), assistant("")], [user("hi")], true)
      ).toBe(false);
    });

    it("ignores a trailing placeholder: acked user + history strictly longer → true (#310)", () => {
      expect(
        shouldReplaceLocalWithServerHistory(
          [user("hi", "sent"), assistant("")],
          [user("hi"), assistant("the completed reply")],
          true
        )
      ).toBe(true);
    });

    it("still honors a REAL partial assistant (non-empty) as mid-stream → true", () => {
      expect(
        shouldReplaceLocalWithServerHistory(
          [user("hi", "sent"), assistant("partial text")],
          [user("hi")],
          true
        )
      ).toBe(true);
    });
  });

  it("returns false when recovery flag is not set (initial load)", () => {
    expect(
      shouldReplaceLocalWithServerHistory(
        [user("hi", "sent")],
        [user("hi"), assistant("hello")],
        false
      )
    ).toBe(false);
  });

  it("returns false when server history is empty (OpenClaw unreachable)", () => {
    expect(
      shouldReplaceLocalWithServerHistory([user("hi", "sent"), assistant("partial")], [], true)
    ).toBe(false);
  });

  it("returns true when local list is empty (initial reconcile after reconnect)", () => {
    expect(shouldReplaceLocalWithServerHistory([], [user("hi"), assistant("hello")], true)).toBe(
      true
    );
  });

  it("returns true when last non-error local message is an assistant turn (mid-stream disconnect)", () => {
    expect(
      shouldReplaceLocalWithServerHistory(
        [user("hi", "sent"), assistant("partial reply")],
        [user("hi"), assistant("complete reply")],
        true
      )
    ).toBe(true);
  });

  it("treats trailing error bubble as non-blocking when an assistant turn precedes it", () => {
    expect(
      shouldReplaceLocalWithServerHistory(
        [user("hi", "sent"), assistant("partial"), assistant("error", { error: true })],
        [user("hi"), assistant("complete")],
        true
      )
    ).toBe(true);
  });

  // Issue #310: WS dropped between ack and first chunk. Last local message is
  // an acked user, history has the assistant reply we never saw.
  it("returns true when last is acked-user AND server history is strictly longer (#310)", () => {
    expect(
      shouldReplaceLocalWithServerHistory(
        [user("what's the vacation policy?", "sent")],
        [user("what's the vacation policy?"), assistant("25 days.")],
        true
      )
    ).toBe(true);
  });

  // Regression guard: a "sending" status means the message was queued during
  // the disconnect (not yet sent on the new connection). Replacing local with
  // history would drop the queued message.
  it("returns false when last user message has status=sending (queued during disconnect)", () => {
    expect(
      shouldReplaceLocalWithServerHistory(
        [user("queued offline", "sending")],
        [user("previous turn"), assistant("previous reply")],
        true
      )
    ).toBe(false);
  });

  // Regression guard: a failed message must not be silently wiped — the user
  // sees a retry affordance in the UI tied to it.
  it("returns false when last user message has status=failed", () => {
    expect(
      shouldReplaceLocalWithServerHistory(
        [user("failed to send", "failed")],
        [user("old"), assistant("old reply")],
        true
      )
    ).toBe(false);
  });

  // Equal-length defends against accidentally adopting a stale-but-different
  // history (e.g. cached pre-disconnect state) when local has progressed.
  it("returns false when last is acked-user but server history is not strictly longer", () => {
    expect(shouldReplaceLocalWithServerHistory([user("hi", "sent")], [user("hi")], true)).toBe(
      false
    );
  });
});
