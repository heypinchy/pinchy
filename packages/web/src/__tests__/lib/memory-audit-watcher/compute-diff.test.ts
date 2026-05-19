import { describe, it, expect } from "vitest";
import { computeLineDiff } from "@/lib/memory-audit-watcher/compute-diff";

describe("computeLineDiff", () => {
  it("counts pure additions", () => {
    expect(computeLineDiff("", "a\nb\n")).toEqual({ addedLines: 2, removedLines: 0 });
  });

  it("counts pure removals", () => {
    expect(computeLineDiff("a\nb\n", "")).toEqual({ addedLines: 0, removedLines: 2 });
  });

  it("counts a single replaced line", () => {
    expect(computeLineDiff("a\nb\nc\n", "a\nX\nc\n")).toEqual({
      addedLines: 1,
      removedLines: 1,
    });
  });

  it("returns 0/0 for identical content", () => {
    expect(computeLineDiff("a\nb\n", "a\nb\n")).toEqual({ addedLines: 0, removedLines: 0 });
  });

  it("treats duplicate lines as a multiset", () => {
    // old has 'a' twice; new has 'a' once → one removed
    expect(computeLineDiff("a\na\nb\n", "a\nb\n")).toEqual({
      addedLines: 0,
      removedLines: 1,
    });
  });

  it("ignores a trailing newline difference", () => {
    expect(computeLineDiff("a\nb", "a\nb\n")).toEqual({ addedLines: 0, removedLines: 0 });
  });
});
