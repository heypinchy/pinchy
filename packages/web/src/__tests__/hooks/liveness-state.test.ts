import { describe, it, expect } from "vitest";
import {
  INITIAL_LIVENESS,
  isRunningStatus,
  livenessReducer,
  type LivenessEvent,
  type LivenessState,
} from "@/hooks/liveness-state";

describe("livenessReducer", () => {
  describe("started", () => {
    it("moves idle → responding", () => {
      expect(livenessReducer(INITIAL_LIVENESS, { type: "started" })).toEqual({
        status: "responding",
      });
    });

    it("moves failed → responding and clears the previous reason", () => {
      const failed: LivenessState = { status: "failed", reason: "boom" };
      expect(livenessReducer(failed, { type: "started" })).toEqual({
        status: "responding",
      });
    });

    it("clears any lingering reason when restarting from slow", () => {
      const slow: LivenessState = { status: "slow", reason: "leftover" };
      expect(livenessReducer(slow, { type: "started" })).toEqual({
        status: "responding",
      });
    });
  });

  describe("slowHint", () => {
    it("moves responding → slow", () => {
      const responding: LivenessState = { status: "responding" };
      expect(livenessReducer(responding, { type: "slowHint" })).toEqual({
        status: "slow",
      });
    });

    it("is a no-op from idle (a slow hint must never alter a non-responding state)", () => {
      expect(livenessReducer(INITIAL_LIVENESS, { type: "slowHint" })).toEqual(INITIAL_LIVENESS);
    });

    it("is a no-op from failed (a slow hint must never resurrect a terminal state)", () => {
      const failed: LivenessState = { status: "failed", reason: "boom" };
      expect(livenessReducer(failed, { type: "slowHint" })).toEqual(failed);
    });

    it("is a no-op when already slow", () => {
      const slow: LivenessState = { status: "slow" };
      expect(livenessReducer(slow, { type: "slowHint" })).toEqual(slow);
    });
  });

  describe("completed", () => {
    it("moves slow → idle", () => {
      const slow: LivenessState = { status: "slow" };
      expect(livenessReducer(slow, { type: "completed" })).toEqual({ status: "idle" });
    });

    it("moves responding → idle and clears any reason", () => {
      const responding: LivenessState = { status: "responding", reason: "stale" };
      expect(livenessReducer(responding, { type: "completed" })).toEqual({ status: "idle" });
    });

    it("from idle stays idle (no spurious transition)", () => {
      expect(livenessReducer(INITIAL_LIVENESS, { type: "completed" })).toEqual({
        status: "idle",
      });
    });

    it("does NOT override a failed state (a late/duplicate completed keeps the failure)", () => {
      // A fast-run reconnect verdict (`liveness: failed`) plus the pipe's own
      // terminal `liveness: completed` can overlap. The authoritative failure
      // must win — only `started`/`reset` clears it.
      const failed: LivenessState = { status: "failed", reason: "gateway dropped" };
      expect(livenessReducer(failed, { type: "completed" })).toEqual(failed);
    });
  });

  describe("failed (the only source of `failed`)", () => {
    it("moves responding → failed with the given reason", () => {
      const responding: LivenessState = { status: "responding" };
      expect(livenessReducer(responding, { type: "failed", reason: "gateway dropped" })).toEqual({
        status: "failed",
        reason: "gateway dropped",
      });
    });

    it("moves slow → failed with the given reason", () => {
      const slow: LivenessState = { status: "slow" };
      expect(livenessReducer(slow, { type: "failed", reason: "timeout from server" })).toEqual({
        status: "failed",
        reason: "timeout from server",
      });
    });

    it("is sticky: a later `completed` keeps `failed`, but `started` clears it", () => {
      const responding: LivenessState = { status: "responding" };
      const failed = livenessReducer(responding, { type: "failed", reason: "real" });
      // A late/duplicate completed must not clear the failure.
      const stillFailed = livenessReducer(failed, { type: "completed" });
      expect(stillFailed).toEqual({ status: "failed", reason: "real" });
      // Only a fresh turn (started) clears it.
      expect(livenessReducer(stillFailed, { type: "started" })).toEqual({ status: "responding" });
    });
  });

  describe("reset", () => {
    it("returns the initial state from any status", () => {
      const slow: LivenessState = { status: "slow", reason: "x" };
      expect(livenessReducer(slow, { type: "reset" })).toEqual(INITIAL_LIVENESS);
    });

    it("clears a failure reason", () => {
      const failed: LivenessState = { status: "failed", reason: "boom" };
      expect(livenessReducer(failed, { type: "reset" })).toEqual({ status: "idle" });
    });
  });

  describe("cardinal rule: `failed` is unreachable without a `failed` event", () => {
    const nonFailedEvents: LivenessEvent[] = [
      { type: "started" },
      { type: "slowHint" },
      { type: "completed" },
      { type: "reset" },
    ];

    // A handful of hand-constructed sequences of arbitrary length/order. None of
    // them contain a `failed` event, so the status must NEVER end up `failed` —
    // this is the whole point of the state machine (no timer can fake a failure).
    const sequences: LivenessEvent[][] = [
      [],
      [{ type: "slowHint" }],
      [{ type: "started" }, { type: "slowHint" }, { type: "completed" }],
      [{ type: "started" }, { type: "completed" }, { type: "slowHint" }],
      [{ type: "reset" }, { type: "slowHint" }, { type: "started" }],
      [
        { type: "started" },
        { type: "slowHint" },
        { type: "slowHint" },
        { type: "reset" },
        { type: "completed" },
        { type: "started" },
      ],
      // a longer pseudo-random walk built only from non-failed events
      Array.from({ length: 50 }, (_, i) => nonFailedEvents[i % nonFailedEvents.length]),
    ];

    it.each(sequences.map((seq, i) => [i, seq] as const))(
      "sequence #%i never produces `failed`",
      (_i, seq) => {
        const result = seq.reduce(livenessReducer, INITIAL_LIVENESS);
        expect(result.status).not.toBe("failed");
      }
    );

    it("only a `failed` event can produce `failed`, even after a long non-failed walk", () => {
      const beforeFailure = sequences[5].reduce(livenessReducer, INITIAL_LIVENESS);
      expect(beforeFailure.status).not.toBe("failed");
      const afterFailure = livenessReducer(beforeFailure, { type: "failed", reason: "real" });
      expect(afterFailure).toEqual({ status: "failed", reason: "real" });
    });
  });

  describe("purity", () => {
    it("does not mutate the input state object", () => {
      const input: LivenessState = { status: "responding" };
      const snapshot = { ...input };
      livenessReducer(input, { type: "slowHint" });
      expect(input).toEqual(snapshot);
    });

    it("does not mutate the input state object on a no-op transition", () => {
      const input: LivenessState = { status: "failed", reason: "boom" };
      const snapshot = { ...input };
      livenessReducer(input, { type: "slowHint" });
      expect(input).toEqual(snapshot);
    });
  });
});

describe("isRunningStatus", () => {
  it("treats responding and slow as running", () => {
    expect(isRunningStatus("responding")).toBe(true);
    expect(isRunningStatus("slow")).toBe(true);
  });

  it("treats idle and failed as not running", () => {
    expect(isRunningStatus("idle")).toBe(false);
    expect(isRunningStatus("failed")).toBe(false);
  });
});
