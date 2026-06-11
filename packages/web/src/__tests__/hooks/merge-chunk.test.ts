import { describe, it, expect } from "vitest";
import { mergeOrAppendChunk } from "@/hooks/merge-chunk";

type Msg = { id: string; role: string; content: string };

describe("mergeOrAppendChunk", () => {
  it("appends a new assistant message when no message has the chunk's id", () => {
    const messages: Msg[] = [{ id: "u1", role: "user", content: "hi" }];
    const incoming: Msg = { id: "a1", role: "assistant", content: "Hel" };
    expect(mergeOrAppendChunk(messages, incoming)).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "Hel" },
    ]);
  });

  it("merges into the trailing assistant message (the common streaming case)", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "Hel" },
    ];
    const incoming: Msg = { id: "a1", role: "assistant", content: "lo" };
    expect(mergeOrAppendChunk(messages, incoming)).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "Hello" },
    ]);
  });

  it("merges into an existing assistant message that is NOT last, instead of appending a duplicate id", () => {
    // The streaming-resume case: after a reload the in-flight assistant message
    // (relabeled to the run id) can sit before a trailing user/history message.
    // The old "check only the last message" logic appended a SECOND message with
    // the same id here, which crashes assistant-ui.
    const messages: Msg[] = [
      { id: "run-9", role: "assistant", content: "partial" },
      { id: "u2", role: "user", content: "later question" },
    ];
    const incoming: Msg = { id: "run-9", role: "assistant", content: " continued" };
    const out = mergeOrAppendChunk(messages, incoming);
    expect(out).toEqual([
      { id: "run-9", role: "assistant", content: "partial continued" },
      { id: "u2", role: "user", content: "later question" },
    ]);
    // Critically: exactly one message carries run-9.
    expect(out.filter((m) => m.id === "run-9")).toHaveLength(1);
  });

  it("does not merge a chunk into a user message that happens to share the id", () => {
    const messages: Msg[] = [{ id: "x", role: "user", content: "u" }];
    const incoming: Msg = { id: "x", role: "assistant", content: "a" };
    expect(mergeOrAppendChunk(messages, incoming)).toEqual([
      { id: "x", role: "user", content: "u" },
      { id: "x", role: "assistant", content: "a" },
    ]);
  });

  describe("in-flight placeholder adoption", () => {
    it("merges the first chunk into a trailing EMPTY assistant placeholder, adopting the chunk's id", () => {
      // The send path appends an empty in-flight assistant placeholder so the
      // list always ends in an assistant while isRunning (kills assistant-ui's
      // optimistic-message count flank). The client can't know the server's
      // messageId before the first chunk — so the placeholder carries a local
      // id and the first chunk must MERGE into it (adopting the server id),
      // not append a second bubble.
      const messages: Msg[] = [
        { id: "u1", role: "user", content: "hi" },
        { id: "local-placeholder", role: "assistant", content: "" },
      ];
      const incoming: Msg = { id: "srv-1", role: "assistant", content: "Hel" };
      expect(mergeOrAppendChunk(messages, incoming)).toEqual([
        { id: "u1", role: "user", content: "hi" },
        { id: "srv-1", role: "assistant", content: "Hel" },
      ]);
    });

    it("does NOT adopt a trailing empty ERROR bubble (it has content '' too)", () => {
      const messages: Array<Msg & { error?: unknown }> = [
        { id: "u1", role: "user", content: "hi" },
        { id: "err-1", role: "assistant", content: "", error: { disconnected: true } },
      ];
      const incoming: Msg = { id: "srv-1", role: "assistant", content: "late chunk" };
      const out = mergeOrAppendChunk(messages, incoming);
      expect(out).toHaveLength(3);
      expect(out[1]).toEqual({
        id: "err-1",
        role: "assistant",
        content: "",
        error: { disconnected: true },
      });
      expect(out[2]).toEqual({ id: "srv-1", role: "assistant", content: "late chunk" });
    });

    it("does NOT adopt a trailing assistant that already has content (different turn)", () => {
      const messages: Msg[] = [{ id: "old-reply", role: "assistant", content: "done earlier" }];
      const incoming: Msg = { id: "srv-2", role: "assistant", content: "new" };
      expect(mergeOrAppendChunk(messages, incoming)).toEqual([
        { id: "old-reply", role: "assistant", content: "done earlier" },
        { id: "srv-2", role: "assistant", content: "new" },
      ]);
    });

    it("prefers an exact id match elsewhere over adopting the trailing placeholder", () => {
      // Resume case: the relabeled in-flight message sits before a trailing
      // placeholder-like message — id match must win.
      const messages: Msg[] = [
        { id: "srv-1", role: "assistant", content: "partial" },
        { id: "u2", role: "user", content: "follow-up" },
        { id: "local-placeholder", role: "assistant", content: "" },
      ];
      const incoming: Msg = { id: "srv-1", role: "assistant", content: " more" };
      expect(mergeOrAppendChunk(messages, incoming)).toEqual([
        { id: "srv-1", role: "assistant", content: "partial more" },
        { id: "u2", role: "user", content: "follow-up" },
        { id: "local-placeholder", role: "assistant", content: "" },
      ]);
    });
  });
});
