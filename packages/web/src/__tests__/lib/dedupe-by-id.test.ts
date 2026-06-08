import { describe, it, expect } from "vitest";
import { dedupeById } from "@/lib/dedupe-by-id";

describe("dedupeById", () => {
  it("returns the array unchanged when all ids are unique", () => {
    const input = [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "c", v: 3 },
    ];
    expect(dedupeById(input)).toEqual(input);
  });

  it("keeps the last occurrence of a duplicated id, at its last position", () => {
    // This is the streaming-resume case: the in-flight assistant message can
    // appear twice (history relabel + resumed stream), both with the same id.
    // assistant-ui's MessageRepository throws on a duplicate id and crashes the
    // whole chat view — so the array handed to it must never contain one.
    const input = [
      { id: "user-1", v: "hi" },
      { id: "run-7", v: "partial" }, // history-relabeled in-flight message
      { id: "run-7", v: "streamed" }, // same id from the resumed stream
    ];
    expect(dedupeById(input)).toEqual([
      { id: "user-1", v: "hi" },
      { id: "run-7", v: "streamed" },
    ]);
  });

  it("collapses every duplicate id to a single entry", () => {
    const input = [
      { id: "x", n: 1 },
      { id: "y", n: 2 },
      { id: "x", n: 3 },
      { id: "y", n: 4 },
      { id: "x", n: 5 },
    ];
    const out = dedupeById(input);
    expect(out).toEqual([
      { id: "y", n: 4 },
      { id: "x", n: 5 },
    ]);
    expect(out.map((o) => o.id)).toEqual([...new Set(out.map((o) => o.id))]);
  });

  it("handles an empty array", () => {
    expect(dedupeById([])).toEqual([]);
  });

  it("keeps every item whose id is undefined (no id to collide on)", () => {
    // assistant-ui's ThreadMessageLike types `id` as optional, so the guard
    // must tolerate undefined ids without collapsing them together.
    const input = [
      { id: undefined, v: 1 },
      { id: "x", v: 2 },
      { id: undefined, v: 3 },
      { id: "x", v: 4 },
    ];
    expect(dedupeById(input)).toEqual([
      { id: undefined, v: 1 },
      { id: undefined, v: 3 },
      { id: "x", v: 4 },
    ]);
  });
});
