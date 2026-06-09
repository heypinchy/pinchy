/**
 * Unit tests for the `ActiveRuns` server-side run registry.
 *
 * Why this exists: when the Browser ↔ Pinchy WebSocket dies mid-stream, the
 * Pinchy ↔ OpenClaw connection keeps draining the stream — but Pinchy has no
 * way to attribute those chunks to anything (issue #310). `ActiveRuns` is the
 * in-memory map keyed by `sessionKey` that holds run state (runId, timing,
 * listener WebSockets) so a watchdog can scan for stuck runs, terminal audit
 * events can describe what happened, and a reconnecting browser can join the
 * existing listener set (Tier 2b).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WebSocket } from "ws";
import { ActiveRuns } from "@/server/active-runs";

// We don't need real ws objects — the registry only cares about identity.
function fakeWs(): WebSocket {
  return {} as unknown as WebSocket;
}

const baseRun = {
  runId: "run-1",
  sessionKey: "agent:a1:direct:u1",
  agentId: "a1",
  userId: "u1",
  agentName: "Smithers",
  startedAt: 1_000_000,
  currentMessageId: "msg-initial",
};

describe("ActiveRuns", () => {
  let runs: ActiveRuns;

  beforeEach(() => {
    runs = new ActiveRuns();
  });

  describe("register", () => {
    it("stores a run keyed by sessionKey with the registering ws as the first listener", () => {
      const ws = fakeWs();
      const created = runs.register({ ...baseRun, ws });

      expect(created.runId).toBe("run-1");
      expect(created.sessionKey).toBe("agent:a1:direct:u1");
      expect(created.agentName).toBe("Smithers");
      expect(created.startedAt).toBe(1_000_000);
      expect(created.lastChunkAt).toBe(1_000_000);
      expect(created.listeners.has(ws)).toBe(true);
      expect(created.listeners.size).toBe(1);

      expect(runs.size()).toBe(1);
      expect(runs.get(baseRun.sessionKey)).toBe(created);
    });

    it("replaces a prior run for the same sessionKey (new user turn supersedes the old)", () => {
      const wsOld = fakeWs();
      const wsNew = fakeWs();
      runs.register({ ...baseRun, runId: "run-old", ws: wsOld });

      const newRun = runs.register({
        ...baseRun,
        runId: "run-new",
        startedAt: 2_000_000,
        ws: wsNew,
      });

      expect(runs.size()).toBe(1);
      expect(runs.get(baseRun.sessionKey)?.runId).toBe("run-new");
      expect(newRun.listeners.has(wsNew)).toBe(true);
      expect(newRun.listeners.has(wsOld)).toBe(false);
    });
  });

  describe("currentMessageId (Tier 2b: per-turn messageId stability across reconnect)", () => {
    it("stores the initial messageId on register and exposes it on get()", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, currentMessageId: "msg-turn-1", ws });
      expect(runs.get(baseRun.sessionKey)?.currentMessageId).toBe("msg-turn-1");
    });

    it("updateMessageId rotates the stored id on per-turn `done` (so reconnect picks up the in-flight turn)", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, currentMessageId: "msg-turn-1", ws });

      runs.updateMessageId(baseRun.sessionKey, "msg-turn-2");

      expect(runs.get(baseRun.sessionKey)?.currentMessageId).toBe("msg-turn-2");
    });

    it("updateMessageId is a no-op for unknown sessionKey", () => {
      expect(() => runs.updateMessageId("agent:gone:direct:u1", "msg-x")).not.toThrow();
    });
  });

  describe("currentContent (Tier 2b: resume buffer for the in-flight reply)", () => {
    it("defaults to an empty string when register omits it", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, ws });
      expect(runs.get(baseRun.sessionKey)?.currentContent).toBe("");
    });

    it("seeds from register input (text emitted before the registering chunk)", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, currentContent: "one ", ws });
      expect(runs.get(baseRun.sessionKey)?.currentContent).toBe("one ");
    });

    it("setContent mirrors the pipe's accumulated emitted text", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, ws });
      runs.setContent(baseRun.sessionKey, "one two");
      expect(runs.get(baseRun.sessionKey)?.currentContent).toBe("one two");
      runs.setContent(baseRun.sessionKey, "one two three");
      expect(runs.get(baseRun.sessionKey)?.currentContent).toBe("one two three");
    });

    it("setContent is a no-op for an unknown sessionKey", () => {
      expect(() => runs.setContent("agent:gone:direct:u1", "x")).not.toThrow();
    });

    it("updateMessageId resets currentContent — the finished turn is now in history", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, ws });
      runs.setContent(baseRun.sessionKey, "first turn reply");
      runs.updateMessageId(baseRun.sessionKey, "msg-turn-2");
      expect(runs.get(baseRun.sessionKey)?.currentContent).toBe("");
    });
  });

  describe("touch", () => {
    it("updates lastChunkAt on every chunk so the watchdog measures inactivity, not absolute age", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, ws });

      runs.touch(baseRun.sessionKey, 1_001_234);
      expect(runs.get(baseRun.sessionKey)?.lastChunkAt).toBe(1_001_234);

      runs.touch(baseRun.sessionKey, 1_005_678);
      expect(runs.get(baseRun.sessionKey)?.lastChunkAt).toBe(1_005_678);
    });

    it("is a no-op for a sessionKey with no registered run", () => {
      expect(() => runs.touch("agent:never:direct:u1", 9_000_000)).not.toThrow();
    });
  });

  describe("delete", () => {
    it("removes the run for a sessionKey", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, ws });
      expect(runs.size()).toBe(1);

      runs.delete(baseRun.sessionKey);

      expect(runs.size()).toBe(0);
      expect(runs.get(baseRun.sessionKey)).toBeUndefined();
    });

    it("is a no-op for an unknown sessionKey", () => {
      expect(() => runs.delete("agent:never:direct:u1")).not.toThrow();
      expect(runs.size()).toBe(0);
    });
  });

  describe("deleteIfRunId (identity-checked delete — don't clobber a newer run on resend)", () => {
    it("deletes the run when the runId matches", () => {
      runs.register({ ...baseRun, ws: fakeWs() });
      runs.deleteIfRunId(baseRun.sessionKey, baseRun.runId);
      expect(runs.get(baseRun.sessionKey)).toBeUndefined();
    });

    it("does NOT delete when the runId differs (a newer run replaced this one)", () => {
      runs.register({ ...baseRun, runId: "run-new", ws: fakeWs() });
      runs.deleteIfRunId(baseRun.sessionKey, "run-old");
      expect(runs.get(baseRun.sessionKey)?.runId).toBe("run-new");
    });

    it("matches the provisional id of a still-pending run", () => {
      runs.registerPending({
        runId: "provisional-1",
        sessionKey: baseRun.sessionKey,
        agentId: "a1",
        userId: "u1",
        agentName: "Smithers",
        currentMessageId: "m1",
        submittedAt: 1_000_000,
        ws: fakeWs(),
      });
      runs.deleteIfRunId(baseRun.sessionKey, "provisional-1");
      expect(runs.get(baseRun.sessionKey)).toBeUndefined();
    });

    it("is a no-op for an unknown sessionKey", () => {
      expect(() => runs.deleteIfRunId("agent:never:direct:u1", "r")).not.toThrow();
      expect(runs.size()).toBe(0);
    });
  });

  describe("addListener", () => {
    it("adds an additional ws as a listener and returns true when the run exists (Tier 2b multi-tab)", () => {
      const wsA = fakeWs();
      const wsB = fakeWs();
      runs.register({ ...baseRun, ws: wsA });

      const added = runs.addListener(baseRun.sessionKey, wsB);

      expect(added).toBe(true);
      const run = runs.get(baseRun.sessionKey);
      expect(run?.listeners.has(wsA)).toBe(true);
      expect(run?.listeners.has(wsB)).toBe(true);
      expect(run?.listeners.size).toBe(2);
    });

    it("returns false when no run exists for the sessionKey (caller should reply with 'no active run')", () => {
      const ws = fakeWs();
      const added = runs.addListener("agent:gone:direct:u1", ws);
      expect(added).toBe(false);
      expect(runs.size()).toBe(0);
    });

    it("is idempotent for a ws that is already a listener (Set semantics)", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, ws });

      expect(runs.addListener(baseRun.sessionKey, ws)).toBe(true);
      expect(runs.get(baseRun.sessionKey)?.listeners.size).toBe(1);
    });
  });

  describe("removeListener", () => {
    it("removes one ws from the listener set without deleting the run", () => {
      const wsA = fakeWs();
      const wsB = fakeWs();
      runs.register({ ...baseRun, ws: wsA });
      runs.addListener(baseRun.sessionKey, wsB);

      runs.removeListener(baseRun.sessionKey, wsA);

      const run = runs.get(baseRun.sessionKey);
      // The run survives even with zero listeners — the OC stream is still
      // being drained server-side. The watchdog tears it down on timeout.
      expect(run).toBeDefined();
      expect(run?.listeners.has(wsA)).toBe(false);
      expect(run?.listeners.has(wsB)).toBe(true);
      expect(run?.listeners.size).toBe(1);
    });

    it("handles removal of a ws that is not currently a listener", () => {
      const wsA = fakeWs();
      const wsOther = fakeWs();
      runs.register({ ...baseRun, ws: wsA });

      expect(() => runs.removeListener(baseRun.sessionKey, wsOther)).not.toThrow();
      expect(runs.get(baseRun.sessionKey)?.listeners.size).toBe(1);
    });
  });

  describe("removeListenerFromAll", () => {
    it("removes a ws from every active run's listener set (used on WS close)", () => {
      const wsClosing = fakeWs();
      const wsOther = fakeWs();

      runs.register({ ...baseRun, sessionKey: "s1", ws: wsClosing });
      runs.addListener("s1", wsOther);

      runs.register({ ...baseRun, runId: "run-2", sessionKey: "s2", ws: wsClosing });

      runs.removeListenerFromAll(wsClosing);

      expect(runs.get("s1")?.listeners.has(wsClosing)).toBe(false);
      expect(runs.get("s1")?.listeners.has(wsOther)).toBe(true);
      expect(runs.get("s2")?.listeners.has(wsClosing)).toBe(false);
    });
  });

  describe("scanForStuckRuns", () => {
    const FIFTEEN_MIN = 15 * 60 * 1000;

    it("returns runs whose startedAt is older than maxRunDurationMs (absolute age cap)", () => {
      const ws = fakeWs();
      const start = 1_000_000;
      runs.register({ ...baseRun, sessionKey: "s-old", startedAt: start, ws });
      runs.register({
        ...baseRun,
        runId: "run-2",
        sessionKey: "s-fresh",
        startedAt: start + FIFTEEN_MIN - 5_000,
        ws,
      });

      const now = start + FIFTEEN_MIN + 1; // exactly 1ms past the cap for s-old
      const stuck = runs.scanForStuckRuns(now, FIFTEEN_MIN);

      expect(stuck).toHaveLength(1);
      expect(stuck[0].sessionKey).toBe("s-old");
    });

    it("returns an empty array when no runs exceed the cap", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, ws });
      expect(runs.scanForStuckRuns(baseRun.startedAt + 60_000, FIFTEEN_MIN)).toEqual([]);
    });

    it("returns an empty array when there are no runs at all", () => {
      expect(runs.scanForStuckRuns(Date.now(), FIFTEEN_MIN)).toEqual([]);
    });

    it("excludes pending runs — they belong to the first-chunk backstop, not the absolute cap", () => {
      const ws = fakeWs();
      const submit = 1_000_000;
      runs.registerPending({
        runId: "p1",
        sessionKey: "s-pending",
        agentId: "a1",
        userId: "u1",
        agentName: "Smithers",
        currentMessageId: "m1",
        submittedAt: submit,
        ws,
      });

      // Even well past the 15-min cap, a never-started run must NOT be reported
      // here — otherwise the watchdog would tear it down twice (once as
      // chat.run_no_first_chunk, once as chat.run_timed_out).
      expect(runs.scanForStuckRuns(submit + FIFTEEN_MIN + 60_000, FIFTEEN_MIN)).toEqual([]);
    });
  });

  describe("values", () => {
    it("iterates over all active runs (used by the watchdog and shutdown hooks)", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, sessionKey: "s1", ws });
      runs.register({ ...baseRun, runId: "run-2", sessionKey: "s2", ws });

      const sessionKeys = Array.from(runs.values()).map((r) => r.sessionKey);
      expect(sessionKeys.sort()).toEqual(["s1", "s2"]);
    });
  });

  // ---------------------------------------------------------------------------
  // B-1: dispatch-time registration + first-chunk backstop.
  //
  // The legacy `register()` runs ONLY on the first chunk that carries a runId,
  // so a run that the backend accepts but never streams (a wedged lane, e.g.
  // rate-limited) is invisible to the watchdog. `registerPending` records the
  // run at DISPATCH time (firstChunkAt=null); `markFirstChunk` reconciles the
  // provisional run to the real runId when streaming actually begins;
  // `scanForUnstartedRuns` is what the watchdog uses to tear down a run that
  // never produced a first chunk within the timeout.
  // ---------------------------------------------------------------------------

  describe("registerPending (dispatch-time registration, before the first chunk)", () => {
    it("stores a pending run with firstChunkAt=null and the dispatching ws as listener", () => {
      const ws = fakeWs();
      const created = runs.registerPending({
        runId: "provisional-1",
        sessionKey: baseRun.sessionKey,
        agentId: "a1",
        userId: "u1",
        agentName: "Smithers",
        currentMessageId: "msg-1",
        submittedAt: 1_000_000,
        ws,
      });

      expect(created.firstChunkAt).toBeNull();
      expect(created.submittedAt).toBe(1_000_000);
      // startedAt seeds to submit time so the absolute 15-min cap is also a
      // backstop; it is re-anchored to the real first-chunk time on reconcile.
      expect(created.startedAt).toBe(1_000_000);
      expect(created.lastChunkAt).toBe(1_000_000);
      expect(created.listeners.has(ws)).toBe(true);
      expect(runs.get(baseRun.sessionKey)).toBe(created);
    });
  });

  describe("markFirstChunk (reconcile provisional run on the first chunk)", () => {
    it("sets firstChunkAt, re-anchors startedAt, reconciles the real runId, keeps the listener", () => {
      const ws = fakeWs();
      runs.registerPending({
        runId: "provisional-1",
        sessionKey: baseRun.sessionKey,
        agentId: "a1",
        userId: "u1",
        agentName: "Smithers",
        currentMessageId: "msg-1",
        submittedAt: 1_000_000,
        ws,
      });

      const ok = runs.markFirstChunk(baseRun.sessionKey, 1_002_000, "real-run-42");

      expect(ok).toBe(true);
      const run = runs.get(baseRun.sessionKey);
      expect(run?.firstChunkAt).toBe(1_002_000);
      expect(run?.startedAt).toBe(1_002_000);
      expect(run?.lastChunkAt).toBe(1_002_000);
      expect(run?.runId).toBe("real-run-42");
      expect(run?.listeners.has(ws)).toBe(true);
    });

    it("returns false for an unknown sessionKey (caller falls back to register)", () => {
      expect(runs.markFirstChunk("agent:gone:direct:u1", 1, "r")).toBe(false);
    });
  });

  describe("scanForUnstartedRuns (the first-chunk backstop the watchdog uses)", () => {
    const NINETY_S = 90_000;

    it("returns pending runs whose submittedAt is older than the first-chunk timeout", () => {
      const ws = fakeWs();
      const submit = 1_000_000;
      runs.registerPending({
        runId: "p1",
        sessionKey: "s-wedged",
        agentId: "a1",
        userId: "u1",
        agentName: "Smithers",
        currentMessageId: "m1",
        submittedAt: submit,
        ws,
      });

      const unstarted = runs.scanForUnstartedRuns(submit + NINETY_S + 1, NINETY_S);

      expect(unstarted).toHaveLength(1);
      expect(unstarted[0].sessionKey).toBe("s-wedged");
    });

    it("excludes pending runs still within the timeout", () => {
      const ws = fakeWs();
      const submit = 1_000_000;
      runs.registerPending({
        runId: "p1",
        sessionKey: "s-young",
        agentId: "a1",
        userId: "u1",
        agentName: "Smithers",
        currentMessageId: "m1",
        submittedAt: submit,
        ws,
      });

      expect(runs.scanForUnstartedRuns(submit + NINETY_S - 1, NINETY_S)).toEqual([]);
    });

    it("excludes runs that have already produced a first chunk", () => {
      const ws = fakeWs();
      const submit = 1_000_000;
      runs.registerPending({
        runId: "p1",
        sessionKey: "s-started",
        agentId: "a1",
        userId: "u1",
        agentName: "Smithers",
        currentMessageId: "m1",
        submittedAt: submit,
        ws,
      });
      runs.markFirstChunk("s-started", submit + 1_000, "real-1");

      // Even long past the first-chunk timeout, a started run is not "unstarted".
      expect(runs.scanForUnstartedRuns(submit + NINETY_S + 10_000, NINETY_S)).toEqual([]);
    });

    it("ignores runs created via the legacy first-chunk register() (already started)", () => {
      const ws = fakeWs();
      runs.register({ ...baseRun, sessionKey: "s-legacy", startedAt: 1_000_000, ws });
      expect(runs.scanForUnstartedRuns(1_000_000 + NINETY_S + 1, NINETY_S)).toEqual([]);
    });
  });
});
