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

  it("re-anchors the trailing assistant's id in place, preserving its content", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "tmp", role: "assistant", content: "partial reply" },
    ];
    expect(ensureTrailingAssistant(messages, anchor)).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "run-1", role: "assistant", content: "partial reply" },
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
