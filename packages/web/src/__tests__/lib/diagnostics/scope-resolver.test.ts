import { describe, it, expect } from "vitest";
import type { Turn } from "@/lib/diagnostics/turn-extractor";
import { computeScope } from "@/lib/diagnostics/scope-resolver";

function makeTurns(n: number): Turn[] {
  return Array.from({ length: n }, (_, i): Turn => ({ index: i, role: "user" }));
}

describe("computeScope", () => {
  describe("without anchor (Settings-triggered export)", () => {
    it("returns the last `windowSize` turns when session is longer", () => {
      const turns = makeTurns(15);
      const scope = computeScope(turns, undefined, 10);
      expect(scope.anchorTurnIndex).toBeNull();
      expect(scope.includedTurnRange).toEqual([5, 14]);
    });

    it("returns the full session when shorter than windowSize", () => {
      const turns = makeTurns(4);
      const scope = computeScope(turns, undefined, 10);
      expect(scope.anchorTurnIndex).toBeNull();
      expect(scope.includedTurnRange).toEqual([0, 3]);
    });

    it("returns an empty range when there are no turns", () => {
      const scope = computeScope([], undefined, 10);
      expect(scope.anchorTurnIndex).toBeNull();
      // [0, -1] represents an empty slice when fed to Turn[].slice(0, -1 + 1).
      expect(scope.includedTurnRange).toEqual([0, -1]);
    });
  });

  describe("with anchor (per-message Report bug)", () => {
    it("centers the window so the anchor is the last included turn", () => {
      const turns = makeTurns(12);
      // anchor index 7 (0-based), windowSize 10 => include [0..7] = 8 turns total;
      // we want exactly `windowSize` turns max, so range = [max(0, 7 - 9), 7] = [0, 7]
      const scope = computeScope(turns, "7", 10);
      expect(scope.anchorTurnIndex).toBe(8); // 1-based count
      expect(scope.includedTurnRange).toEqual([0, 7]);
    });

    it("clamps the start to 0 when the anchor is near the beginning", () => {
      const turns = makeTurns(12);
      const scope = computeScope(turns, "2", 10);
      expect(scope.anchorTurnIndex).toBe(3);
      expect(scope.includedTurnRange).toEqual([0, 2]);
    });

    it("includes the full window when there are enough preceding turns", () => {
      const turns = makeTurns(50);
      // anchor index 30, windowSize 10 => range = [21, 30]
      const scope = computeScope(turns, "30", 10);
      expect(scope.anchorTurnIndex).toBe(31);
      expect(scope.includedTurnRange).toEqual([21, 30]);
    });

    it("falls back to no-anchor when anchorMessageId does not match any turn", () => {
      const turns = makeTurns(15);
      const scope = computeScope(turns, "not-a-number", 10);
      expect(scope.anchorTurnIndex).toBeNull();
      expect(scope.includedTurnRange).toEqual([5, 14]);
    });

    it("falls back to no-anchor for an opaque id that merely starts with digits", () => {
      // assistant-ui message ids are opaque (nanoid-style) strings that begin
      // with a digit ~16% of the time. parseInt would leniently read the
      // leading digit as a turn index ("1-aBcD" -> 1), wrongly anchoring the
      // bundle and flaking diagnostics-export.spec.ts. Only a *pure* integer
      // string is a valid stringified turn index in v1.
      const turns = makeTurns(15);
      const scope = computeScope(turns, "1-aBcD3fG", 10);
      expect(scope.anchorTurnIndex).toBeNull();
      expect(scope.includedTurnRange).toEqual([5, 14]);
    });

    it("falls back to no-anchor when anchorMessageId is out of range", () => {
      const turns = makeTurns(15);
      const scope = computeScope(turns, "99", 10);
      expect(scope.anchorTurnIndex).toBeNull();
      expect(scope.includedTurnRange).toEqual([5, 14]);
    });

    it("falls back to no-anchor for an opaque message id that merely starts with digits", () => {
      // assistant-ui message ids are opaque strings; some happen to start with
      // a digit (e.g. "7f3a2b9c"). parseInt would read the leading 7 and wrongly
      // anchor turn 7. A turn index is an ALL-digits string; anything else must
      // fall back. Without the guard this is non-deterministic — it only
      // misfires when the random id starts with an in-range digit — which is the
      // root cause of the flaky diagnostics-export E2E (#461 CI).
      const turns = makeTurns(15);
      const scope = computeScope(turns, "7f3a2b9c", 10);
      expect(scope.anchorTurnIndex).toBeNull();
      expect(scope.includedTurnRange).toEqual([5, 14]);
    });

    it("falls back to no-anchor for an opaque id starting with an in-range zero", () => {
      const turns = makeTurns(15);
      const scope = computeScope(turns, "0abc-def", 10);
      expect(scope.anchorTurnIndex).toBeNull();
      expect(scope.includedTurnRange).toEqual([5, 14]);
    });
  });
});
