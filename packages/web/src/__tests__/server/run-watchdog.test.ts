/**
 * Unit tests for the server-side `RunWatchdog`. The watchdog scans the
 * `ActiveRuns` registry every 30s, finds runs whose absolute age exceeds
 * the per-deployment cap (default 15 min), and tears them down: abort the
 * OC run, broadcast a terminal error frame to listeners, write the
 * `chat.run_timed_out` audit row, drop the entry from the registry.
 *
 * Why this exists: stuck runs are the worst observability blind spot.
 * Before #310 Tier 2, a hung OC run had no audit trail, no operator
 * signal, and depended on the browser's client-side timer firing — which
 * doesn't fire if the tab is backgrounded. The watchdog is the
 * server-side belt to that suspenders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { ActiveRuns, type ActiveRun } from "@/server/active-runs";
import { runWatchdogTick, type WatchdogDeps } from "@/server/run-watchdog";

function fakeWs(): WebSocket {
  return {} as unknown as WebSocket;
}

const FIFTEEN_MIN = 15 * 60 * 1000;
const NINETY_S = 90 * 1000;
const baseRun = {
  runId: "run-1",
  sessionKey: "agent:a1:direct:u1",
  agentId: "a1",
  userId: "u1",
  agentName: "Smithers",
  startedAt: 1_000_000,
};

// Shared shape for a dispatch-time (pending) registration in these tests.
const basePending = {
  runId: "provisional-1",
  sessionKey: "agent:a1:direct:u1",
  agentId: "a1",
  userId: "u1",
  agentName: "Smithers",
  currentMessageId: "m1",
};

describe("runWatchdogTick", () => {
  let runs: ActiveRuns;
  let chatAbort: ReturnType<typeof vi.fn>;
  let writeAudit: ReturnType<typeof vi.fn>;
  let broadcastTimeout: ReturnType<typeof vi.fn>;
  let broadcastNoFirstChunk: ReturnType<typeof vi.fn>;
  let deps: WatchdogDeps;

  beforeEach(() => {
    runs = new ActiveRuns();
    chatAbort = vi.fn().mockResolvedValue(undefined);
    writeAudit = vi.fn().mockResolvedValue(undefined);
    broadcastTimeout = vi.fn();
    broadcastNoFirstChunk = vi.fn();
    deps = {
      activeRuns: runs,
      chatAbort,
      writeAudit,
      broadcastTimeout,
      broadcastNoFirstChunk,
      now: () => 1_000_000 + FIFTEEN_MIN + 1,
      maxRunDurationMs: FIFTEEN_MIN,
      firstChunkTimeoutMs: NINETY_S,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when there are no active runs", async () => {
    await runWatchdogTick(deps);
    expect(chatAbort).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(broadcastTimeout).not.toHaveBeenCalled();
  });

  it("does nothing when no run is stuck", async () => {
    runs.register({ ...baseRun, startedAt: deps.now() - 60_000, ws: fakeWs() });
    await runWatchdogTick(deps);
    expect(chatAbort).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(runs.size()).toBe(1);
  });

  it("aborts the OC run, writes a chat.run_timed_out audit row, broadcasts to listeners, and drops the entry", async () => {
    const ws = fakeWs();
    runs.register({ ...baseRun, ws });

    await runWatchdogTick(deps);

    expect(chatAbort).toHaveBeenCalledTimes(1);
    expect(chatAbort).toHaveBeenCalledWith(baseRun.sessionKey, baseRun.runId);

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const auditCall = writeAudit.mock.calls[0]![0];
    expect(auditCall.eventType).toBe("chat.run_timed_out");
    expect(auditCall.actorType).toBe("system");
    expect(auditCall.outcome).toBe("failure");
    expect(auditCall.resource).toBe(`agent:${baseRun.agentId}`);
    expect(auditCall.detail.agent).toEqual({ id: baseRun.agentId, name: baseRun.agentName });
    expect(auditCall.detail.user).toEqual({ id: baseRun.userId });
    expect(auditCall.detail.sessionKey).toBe(baseRun.sessionKey);
    expect(auditCall.detail.runId).toBe(baseRun.runId);
    expect(auditCall.detail.elapsedMs).toBe(FIFTEEN_MIN + 1);
    expect(auditCall.detail.maxRunDurationMs).toBe(FIFTEEN_MIN);

    expect(broadcastTimeout).toHaveBeenCalledTimes(1);
    const broadcastCall = broadcastTimeout.mock.calls[0]![0] as ActiveRun;
    expect(broadcastCall.sessionKey).toBe(baseRun.sessionKey);

    expect(runs.size()).toBe(0);
  });

  it("processes multiple stuck runs in a single tick", async () => {
    runs.register({ ...baseRun, sessionKey: "s1", ws: fakeWs() });
    runs.register({
      ...baseRun,
      sessionKey: "s2",
      runId: "run-2",
      agentName: "Other",
      ws: fakeWs(),
    });

    await runWatchdogTick(deps);

    expect(chatAbort).toHaveBeenCalledTimes(2);
    expect(writeAudit).toHaveBeenCalledTimes(2);
    expect(runs.size()).toBe(0);
  });

  it("continues processing other stuck runs even if chatAbort throws for one", async () => {
    chatAbort.mockImplementation(async (sessionKey: string) => {
      if (sessionKey === "s1") throw new Error("OC gateway disconnected");
    });

    runs.register({ ...baseRun, sessionKey: "s1", ws: fakeWs() });
    runs.register({ ...baseRun, sessionKey: "s2", runId: "run-2", ws: fakeWs() });

    await runWatchdogTick(deps);

    // The audit row must still land for the abort-failed run — that's the
    // whole point of writing audit BEFORE the side effects. Operators need
    // to see "we tried to kill a stuck run and even the abort failed".
    expect(writeAudit).toHaveBeenCalledTimes(2);
    expect(runs.size()).toBe(0);
  });

  it("continues processing other stuck runs even if writeAudit throws for one", async () => {
    writeAudit.mockImplementation(async (entry: { detail: { sessionKey: string } }) => {
      if (entry.detail.sessionKey === "s1") throw new Error("audit DB down");
    });

    runs.register({ ...baseRun, sessionKey: "s1", ws: fakeWs() });
    runs.register({ ...baseRun, sessionKey: "s2", runId: "run-2", ws: fakeWs() });

    await runWatchdogTick(deps);

    // chatAbort and broadcastTimeout still fire for s1 (best-effort) AND
    // both still fire for s2 — a failing writeAudit for s1 must not
    // poison the loop.
    expect(chatAbort).toHaveBeenCalledTimes(2);
    expect(broadcastTimeout).toHaveBeenCalledTimes(2);
    expect(runs.size()).toBe(0);
  });

  it("continues processing other stuck runs even if broadcastTimeout throws for one", async () => {
    broadcastTimeout.mockImplementation((run: ActiveRun) => {
      if (run.sessionKey === "s1") throw new Error("send to dead socket");
    });

    runs.register({ ...baseRun, sessionKey: "s1", ws: fakeWs() });
    runs.register({ ...baseRun, sessionKey: "s2", runId: "run-2", ws: fakeWs() });

    await runWatchdogTick(deps);

    // Audit and abort still ran for both. s1's failed broadcast didn't
    // stop the registry-delete or s2's processing.
    expect(writeAudit).toHaveBeenCalledTimes(2);
    expect(chatAbort).toHaveBeenCalledTimes(2);
    expect(runs.size()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // B-1: first-chunk backstop. A run the backend ACCEPTED but never streamed
  // (a wedged/rate-limited lane) is registered as "pending" at dispatch time.
  // If no first chunk arrives within firstChunkTimeoutMs, the watchdog tears it
  // down with a *retryable* error so the user isn't stuck on a blank thread —
  // distinct from the terminal 15-min absolute timeout.
  // ---------------------------------------------------------------------------
  describe("first-chunk backstop (pending runs that never stream)", () => {
    it("audits chat.run_no_first_chunk, aborts, broadcasts retryable, and drops the entry", async () => {
      const ws = fakeWs();
      // submittedAt 90s+ before now() → past the first-chunk timeout.
      runs.registerPending({ ...basePending, submittedAt: 1_000_000, ws });

      await runWatchdogTick(deps);

      expect(writeAudit).toHaveBeenCalledTimes(1);
      const audit = writeAudit.mock.calls[0]![0];
      expect(audit.eventType).toBe("chat.run_no_first_chunk");
      expect(audit.actorType).toBe("system");
      expect(audit.actorId).toBe("watchdog");
      expect(audit.outcome).toBe("failure");
      expect(audit.resource).toBe("agent:a1");
      expect(audit.detail.agent).toEqual({ id: "a1", name: "Smithers" });
      expect(audit.detail.user).toEqual({ id: "u1" });
      expect(audit.detail.sessionKey).toBe(basePending.sessionKey);
      expect(audit.detail.runId).toBe("provisional-1");
      expect(audit.detail.waitedMs).toBe(deps.now() - 1_000_000);
      expect(audit.detail.firstChunkTimeoutMs).toBe(NINETY_S);
      // No PII in detail.
      expect(JSON.stringify(audit.detail)).not.toContain("@");

      expect(chatAbort).toHaveBeenCalledTimes(1);
      expect(chatAbort).toHaveBeenCalledWith(basePending.sessionKey, "provisional-1");

      // Retryable broadcast, NOT the terminal timeout broadcast.
      expect(broadcastNoFirstChunk).toHaveBeenCalledTimes(1);
      expect(broadcastNoFirstChunk.mock.calls[0]![0].sessionKey).toBe(basePending.sessionKey);
      expect(broadcastTimeout).not.toHaveBeenCalled();

      expect(runs.size()).toBe(0);
    });

    it("leaves a pending run that is still within the first-chunk timeout untouched", async () => {
      const ws = fakeWs();
      runs.registerPending({ ...basePending, submittedAt: deps.now() - 1_000, ws });

      await runWatchdogTick(deps);

      expect(writeAudit).not.toHaveBeenCalled();
      expect(chatAbort).not.toHaveBeenCalled();
      expect(broadcastNoFirstChunk).not.toHaveBeenCalled();
      expect(runs.size()).toBe(1);
    });

    it("a run that DID start is governed by the absolute cap, not the first-chunk backstop", async () => {
      const ws = fakeWs();
      // Pending, then a first chunk arrives 15min+ ago → it's a started, stuck run.
      runs.registerPending({ ...basePending, submittedAt: 1_000_000, ws });
      runs.markFirstChunk(basePending.sessionKey, 1_000_000, "real-run-7");

      await runWatchdogTick(deps);

      // Terminal timeout path fired, not the retryable no-first-chunk path.
      expect(broadcastTimeout).toHaveBeenCalledTimes(1);
      expect(broadcastNoFirstChunk).not.toHaveBeenCalled();
      expect(writeAudit.mock.calls[0]![0].eventType).toBe("chat.run_timed_out");
      expect(writeAudit.mock.calls[0]![0].detail.runId).toBe("real-run-7");
      expect(runs.size()).toBe(0);
    });

    it("processes both a stuck (started) run and an unstarted run in one tick", async () => {
      runs.register({ ...baseRun, sessionKey: "s-stuck", ws: fakeWs() });
      runs.registerPending({
        ...basePending,
        sessionKey: "s-unstarted",
        submittedAt: 1_000_000,
        ws: fakeWs(),
      });

      await runWatchdogTick(deps);

      expect(broadcastTimeout).toHaveBeenCalledTimes(1);
      expect(broadcastNoFirstChunk).toHaveBeenCalledTimes(1);
      expect(writeAudit).toHaveBeenCalledTimes(2);
      const events = writeAudit.mock.calls.map((c) => c[0].eventType).sort();
      expect(events).toEqual(["chat.run_no_first_chunk", "chat.run_timed_out"]);
      expect(runs.size()).toBe(0);
    });

    it("continues processing other unstarted runs even if broadcastNoFirstChunk throws for one", async () => {
      broadcastNoFirstChunk.mockImplementation((run: ActiveRun) => {
        if (run.sessionKey === "p1") throw new Error("send to dead socket");
      });
      runs.registerPending({
        ...basePending,
        sessionKey: "p1",
        submittedAt: 1_000_000,
        ws: fakeWs(),
      });
      runs.registerPending({
        ...basePending,
        sessionKey: "p2",
        submittedAt: 1_000_000,
        ws: fakeWs(),
      });

      await runWatchdogTick(deps);

      // Audit + abort still ran for both; p1's failed broadcast didn't poison the loop.
      expect(writeAudit).toHaveBeenCalledTimes(2);
      expect(chatAbort).toHaveBeenCalledTimes(2);
      expect(runs.size()).toBe(0);
    });

    it("does NOT abort a pending run that produced its first chunk during the audit write (S-2 race)", async () => {
      const ws = fakeWs();
      runs.registerPending({ ...basePending, submittedAt: 1_000_000, ws });
      // Simulate a real first chunk arriving (reconciling the run) while the
      // no_first_chunk audit row is in flight — the watchdog must not then go
      // on to abort a run that just started streaming.
      writeAudit.mockImplementation(async () => {
        runs.markFirstChunk(basePending.sessionKey, deps.now(), "real-late");
      });

      await runWatchdogTick(deps);

      expect(chatAbort).not.toHaveBeenCalled();
      expect(broadcastNoFirstChunk).not.toHaveBeenCalled();
      // The run started mid-teardown — leave it in the registry under the
      // absolute 15-min cap instead of killing it.
      expect(runs.size()).toBe(1);
    });

    it("does not delete or notify a NEWER run that replaced the pending run during the chatAbort await (resend race)", async () => {
      runs.registerPending({
        ...basePending,
        sessionKey: "s-race",
        submittedAt: 1_000_000,
        ws: fakeWs(),
      });
      // During the (networked) chatAbort the user — who has stared at a blank
      // thread for 90s — resends. Run B replaces the entry on the same session.
      chatAbort.mockImplementation(async () => {
        runs.registerPending({
          ...basePending,
          runId: "msg-B",
          sessionKey: "s-race",
          currentMessageId: "msg-B",
          submittedAt: 2_000_000,
          ws: fakeWs(),
        });
      });

      await runWatchdogTick(deps);

      // A was aborted + audited, but B (the resend) must survive untouched and
      // must NOT receive A's "didn't start responding" frame on the shared ws.
      expect(chatAbort).toHaveBeenCalledTimes(1);
      const survivor = runs.get("s-race");
      expect(survivor).toBeDefined();
      expect(survivor!.runId).toBe("msg-B");
      expect(survivor!.firstChunkAt).toBeNull();
      expect(broadcastNoFirstChunk).not.toHaveBeenCalled();
    });
  });
});
