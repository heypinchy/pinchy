import { describe, it, expect } from "vitest";
import {
  isInFlightPlaceholder,
  replaceTrailingPlaceholder,
  stripTrailingPlaceholder,
} from "@/hooks/in-flight-placeholder";

type Msg = { id: string; role: string; content: string; error?: unknown; status?: string };

const user: Msg = { id: "u1", role: "user", content: "hi", status: "sent" };
const placeholder: Msg = { id: "ph-1", role: "assistant", content: "" };
const errorBubble: Msg = {
  id: "e1",
  role: "assistant",
  content: "",
  error: { disconnected: true },
};

describe("isInFlightPlaceholder", () => {
  it("matches an empty assistant message without error", () => {
    expect(isInFlightPlaceholder(placeholder)).toBe(true);
  });

  it("rejects error bubbles, user messages, and assistants with content", () => {
    expect(isInFlightPlaceholder(errorBubble)).toBe(false);
    expect(isInFlightPlaceholder(user)).toBe(false);
    expect(isInFlightPlaceholder({ id: "a", role: "assistant", content: "x" })).toBe(false);
  });
});

describe("replaceTrailingPlaceholder", () => {
  it("replaces a trailing placeholder with the bubble — count stays stable", () => {
    // This is the crash-class guard: error/timeout/disconnect bubbles used to
    // APPEND while assistant-ui's optimistic message vanished in the same
    // transition — with the placeholder, the bubble takes its slot instead.
    const out = replaceTrailingPlaceholder([user, placeholder], errorBubble);
    expect(out).toEqual([user, errorBubble]);
  });

  it("appends when there is no trailing placeholder", () => {
    const out = replaceTrailingPlaceholder([user], errorBubble);
    expect(out).toEqual([user, errorBubble]);
  });

  it("does not touch a trailing assistant that already streamed content", () => {
    const partial: Msg = { id: "a1", role: "assistant", content: "partial" };
    const out = replaceTrailingPlaceholder([user, partial], errorBubble);
    expect(out).toEqual([user, partial, errorBubble]);
  });
});

describe("stripTrailingPlaceholder", () => {
  it("removes a trailing placeholder (for history-comparison logic)", () => {
    expect(stripTrailingPlaceholder([user, placeholder])).toEqual([user]);
  });

  it("returns the list unchanged when nothing trails", () => {
    expect(stripTrailingPlaceholder([user])).toEqual([user]);
    expect(stripTrailingPlaceholder([user, errorBubble])).toEqual([user, errorBubble]);
  });
});
