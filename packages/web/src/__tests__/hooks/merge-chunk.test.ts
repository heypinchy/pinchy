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
});
