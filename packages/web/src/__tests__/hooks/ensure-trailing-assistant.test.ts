import { describe, it, expect } from "vitest";
import { ensureTrailingAssistant } from "@/hooks/ensure-trailing-assistant";

type Msg = { id: string; role: string; content: string };

const anchor: Msg = { id: "run-1", role: "assistant", content: "" };

describe("ensureTrailingAssistant", () => {
  it("appends the anchor when history ends in a user message (unpersisted reply)", () => {
    const messages: Msg[] = [{ id: "u1", role: "user", content: "hi" }];
    expect(ensureTrailingAssistant(messages, anchor)).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "run-1", role: "assistant", content: "" },
    ]);
  });

  it("re-anchors the trailing assistant's id, keeping the longer persisted content when the resume buffer is empty", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "tmp", role: "assistant", content: "partial reply" },
    ];
    // anchor.content is "" (empty resume buffer) — must NOT shrink the reply.
    expect(ensureTrailingAssistant(messages, anchor)).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "run-1", role: "assistant", content: "partial reply" },
    ]);
  });

  it("adopts the resume buffer when it is more complete than the persisted partial", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "list one..ten" },
      { id: "tmp", role: "assistant", content: "one two" },
    ];
    const fullerAnchor: Msg = { id: "run-1", role: "assistant", content: "one two three four" };
    expect(ensureTrailingAssistant(messages, fullerAnchor)).toEqual([
      { id: "u1", role: "user", content: "list one..ten" },
      { id: "run-1", role: "assistant", content: "one two three four" },
    ]);
  });

  it("keeps the resume buffer when the persisted reply runs ahead of it, because the deltas after the buffer still arrive", () => {
    // The resume buffer is snapshotted when the socket joins the run; every
    // delta after that point reaches the client and is merged onto the anchor.
    // A transcript that already holds some of those words would get them twice
    // ("one two two three…") if it replaced the buffer as the base.
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "list one..ten" },
      { id: "tmp", role: "assistant", content: "one two" },
    ];
    const bufferAnchor: Msg = { id: "run-1", role: "assistant", content: "one" };
    expect(ensureTrailingAssistant(messages, bufferAnchor)).toEqual([
      { id: "u1", role: "user", content: "list one..ten" },
      { id: "run-1", role: "assistant", content: "one" },
    ]);
  });

  it("keeps a longer persisted reply that the resume buffer does not continue", () => {
    // A different text (the previous turn's reply of a multi-turn run, say) is
    // not a lagging copy of the buffer, so no delta will rebuild it.
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "tmp", role: "assistant", content: "Let me look that up for you." },
    ];
    const otherAnchor: Msg = { id: "run-1", role: "assistant", content: "Found" };
    expect(ensureTrailingAssistant(messages, otherAnchor)).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "run-1", role: "assistant", content: "Let me look that up for you." },
    ]);
  });

  it("appends when an assistant exists but a newer user turn trails it", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "reply" },
      { id: "u2", role: "user", content: "second" },
    ];
    const out = ensureTrailingAssistant(messages, anchor);
    expect(out[out.length - 1]).toEqual({ id: "run-1", role: "assistant", content: "" });
    // The earlier assistant keeps its own id — only the trailing anchor carries run-1.
    expect(out.filter((m) => m.id === "run-1")).toHaveLength(1);
    expect(out).toHaveLength(4);
  });

  it("appends the anchor for an empty history (run in flight, nothing persisted)", () => {
    expect(ensureTrailingAssistant([] as Msg[], anchor)).toEqual([anchor]);
  });

  it("always yields an assistant as the last message", () => {
    for (const messages of [
      [] as Msg[],
      [{ id: "u1", role: "user", content: "a" }],
      [
        { id: "u1", role: "user", content: "a" },
        { id: "a1", role: "assistant", content: "b" },
      ],
    ]) {
      const out = ensureTrailingAssistant(messages, anchor);
      expect(out[out.length - 1]!.role).toBe("assistant");
    }
  });
});
