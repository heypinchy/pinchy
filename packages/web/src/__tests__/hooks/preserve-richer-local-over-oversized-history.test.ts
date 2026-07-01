/**
 * Unit tests for `preserveRicherLocalOverOversizedHistory` — the merge step
 * that runs on every history-reconcile. OpenClaw's `chat.history` RPC caps
 * single-message size (128 KB — an inline image routinely trips this) and
 * replaces an oversized message with a placeholder (server-side translated
 * and flagged `oversized: true` in client-router.ts's fetchAndParseHistory).
 * Without this merge, a tab refocus after sending an image to a text-only
 * agent replaces the rich local user bubble (text + file chip) with the
 * degraded placeholder — the vanishing-user-message bug found in v0.8.0
 * staging. This function restores the richer local copy at that position
 * while leaving genuine shrinks (real deletions/compaction) untouched, since
 * those never carry the `oversized` flag.
 */
import { describe, it, expect } from "vitest";
import { preserveRicherLocalOverOversizedHistory, type WsMessage } from "@/hooks/use-ws-runtime";
import { OVERSIZED_HISTORY_MESSAGE_TEXT } from "@/lib/openclaw-history";

function user(content: string, opts: Partial<WsMessage> = {}): WsMessage {
  return { id: `u-${content}`, role: "user", content, ...opts };
}

function assistant(content: string, opts: Partial<WsMessage> = {}): WsMessage {
  return { id: `a-${content}`, role: "assistant", content, ...opts };
}

describe("preserveRicherLocalOverOversizedHistory", () => {
  it("returns historyMessages unchanged when nothing is flagged oversized", () => {
    const history = [user("hi"), assistant("hello")];
    const prev = [user("hi"), assistant("hello")];
    expect(preserveRicherLocalOverOversizedHistory(history, prev)).toBe(history);
  });

  it("substitutes the richer local message at the oversized position", () => {
    const history = [
      user(OVERSIZED_HISTORY_MESSAGE_TEXT, { oversized: true }),
      assistant("Nice picture!"),
    ];
    const prev = [
      user("Was hältst du von dem Bild?", {
        files: [{ filename: "photo.jpg", mimeType: "image/jpeg" }],
      }),
      assistant("Nice picture!"),
    ];

    const merged = preserveRicherLocalOverOversizedHistory(history, prev);

    expect(merged[0]).toEqual(prev[0]);
    expect(merged[1]).toEqual(history[1]);
  });

  it("keeps the server placeholder when there is no local message at that position (fresh load, no cache)", () => {
    const history = [
      user(OVERSIZED_HISTORY_MESSAGE_TEXT, { oversized: true }),
      assistant("Nice picture!"),
    ];
    const merged = preserveRicherLocalOverOversizedHistory(history, []);
    expect(merged[0]).toEqual(history[0]);
  });

  it("keeps the server placeholder when the local message at that position is itself empty", () => {
    // No richer copy to fall back to — nothing is lost by keeping the
    // friendly placeholder text instead of an empty local bubble.
    const history = [
      user(OVERSIZED_HISTORY_MESSAGE_TEXT, { oversized: true }),
      assistant("Nice picture!"),
    ];
    const prev = [user(""), assistant("Nice picture!")];
    const merged = preserveRicherLocalOverOversizedHistory(history, prev);
    expect(merged[0]).toEqual(history[0]);
  });

  it("does not substitute when the local message at that position has a different role", () => {
    // Defends against a mismatched merge if positions ever drift between the
    // two arrays — only ever substitute a like-for-like role.
    const history = [
      user(OVERSIZED_HISTORY_MESSAGE_TEXT, { oversized: true }),
      assistant("Nice picture!"),
    ];
    const prev = [assistant("unrelated"), assistant("Nice picture!")];
    const merged = preserveRicherLocalOverOversizedHistory(history, prev);
    expect(merged[0]).toEqual(history[0]);
  });

  it("ignores a trailing client-only placeholder when aligning positions", () => {
    // stripTrailingPlaceholder parity with shouldReplaceLocalWithServerHistory
    // — the send path can append an empty assistant placeholder that the
    // server never knows about; it must not shift the alignment.
    const history = [
      user(OVERSIZED_HISTORY_MESSAGE_TEXT, { oversized: true }),
      assistant("Nice picture!"),
    ];
    const prev = [
      user("Was hältst du von dem Bild?", {
        files: [{ filename: "photo.jpg", mimeType: "image/jpeg" }],
      }),
      assistant("Nice picture!"),
      assistant(""), // trailing in-flight placeholder
    ];
    const merged = preserveRicherLocalOverOversizedHistory(history, prev);
    expect(merged[0]).toEqual(prev[0]);
  });

  it("leaves a genuine shrink (no oversized flag) untouched — not this function's concern", () => {
    const history = [assistant("hello")];
    const prev = [user("hi"), assistant("hello")];
    expect(preserveRicherLocalOverOversizedHistory(history, prev)).toBe(history);
  });

  it("substitutes across a leading client-only greeting that offsets the local list", () => {
    // The common real case: an agent greeting is a client-only assistant
    // message at index 0 that OpenClaw never persists, so the local list is
    // one longer than server history. Head-index alignment would pair the
    // oversized user turn with the greeting (role mismatch → miss) and lose
    // the rich message. Tail alignment pairs the persisted suffix correctly.
    const history = [
      user(OVERSIZED_HISTORY_MESSAGE_TEXT, { oversized: true }),
      assistant("Nice picture!"),
    ];
    const prev = [
      assistant("Hi, I am Texti!"), // greeting — client-only, not in server history
      user("Was hältst du von dem Bild?", {
        files: [{ filename: "photo.jpg", mimeType: "image/jpeg" }],
      }),
      assistant("Nice picture!"),
    ];

    const merged = preserveRicherLocalOverOversizedHistory(history, prev);

    expect(merged[0]).toEqual(prev[1]); // the rich user turn, not the greeting
    expect(merged[1]).toEqual(history[1]);
  });

  it("never substitutes a synthetic error bubble as the missing message", () => {
    // A disconnect error bubble is a client-only assistant message with an
    // `error` set; even if alignment lands on it, it must never masquerade as
    // the user's lost content.
    const history = [
      assistant(OVERSIZED_HISTORY_MESSAGE_TEXT, { oversized: true }),
      assistant("later reply"),
    ];
    const prev = [
      assistant("some visible error text", { error: { message: "disconnected" } }),
      assistant("later reply"),
    ];
    const merged = preserveRicherLocalOverOversizedHistory(history, prev);
    expect(merged[0]).toEqual(history[0]); // kept the placeholder, not the error bubble
  });
});
