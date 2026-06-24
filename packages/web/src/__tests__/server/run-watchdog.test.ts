/**
 * Unit tests for the server-side `RunWatchdog`. The watchdog scans the
 * `ActiveRuns` registry every 30s for the FIRST-CHUNK backstop only: a run
 * Pinchy dispatched but the gateway never acknowledged (no first chunk within
 * the timeout — a wedged/rate-limited lane, a dispatch race OpenClaw can't see).
 * It tears such a run down with a RETRYABLE error: abort the OC run, broadcast a
 * "didn't start responding" frame to listeners, write the
 * `chat.run_no_first_chunk` audit row, drop the entry.
 *
 * The redundant 15-min absolute-duration cap (`chat.run_timed_out`) was REMOVED
 * (chat-liveness-observer Task 2A, Part 3): OpenClaw self-aborts stuck/idle runs
 * (120s idle, ~5min stuck), so a Pinchy-side absolute cap was both redundant AND
 * harmful — it killed slow-but-alive runs. Authoritative run liveness now comes
 * from the gateway's `agentWait` oracle (see client-router.ts).
 *
 * Why the first-chunk guard stays: stuck-at-dispatch runs are the worst
 * observability blind spot. Before #310 Tier 2, a dispatched-but-never-streamed
 * OC run had no audit trail, no operator signal, and depended on the browser's
 * client-side timer firing — which doesn't fire if the tab is backgrounded. The
 * watchdog is the server-side belt to that suspenders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { ActiveRuns, type ActiveRun } from "@/server/active-runs";
import { runWatchdogTick, startRunWatchdog, type WatchdogDeps } from "@/server/run-watchdog";

function fakeWs(): WebSocket {
  return {} as unknown as WebSocket;
}

const FIFTEEN_MIN = 15 * 60 * 1000;
const NINETY_S = 90 * 1000;

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
  let broadcastNoFirstChunk: ReturnType<typeof vi.fn>;
  let deps: WatchdogDeps;

  beforeEach(() => {
    runs = new ActiveRuns();
    chatAbort = vi.fn().mockResolvedValue(undefined);
    writeAudit = vi.fn().mockResolvedValue(undefined);
    broadcastNoFirstChunk = vi.fn();
    deps = {
      activeRuns: runs,
      chatAbort,
      writeAudit,
      broadcastNoFirstChunk,
      now: () => 1_000_000 + FIFTEEN_MIN + 1,
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
    expect(broadcastNoFirstChunk).not.toHaveBeenCalled();
  });

  it("leaves a STARTED run alone — OpenClaw, not Pinchy, owns its liveness now", async () => {
    const ws = fakeWs();
    // A run that started streaming 15min+ ago. Pinchy no longer caps started-run
    // duration; OpenClaw self-aborts stuck/idle runs and `agentWait` is the
    // authoritative oracle. The watchdog must NOT tear this down.
    runs.registerPending({ ...basePending, submittedAt: 1_000_000, ws });
    runs.markFirstChunk(basePending.sessionKey, 1_000_000, "real-run-7");

    await runWatchdogTick(deps);

    expect(chatAbort).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(broadcastNoFirstChunk).not.toHaveBeenCalled();
    expect(runs.size()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // B-1: first-chunk backstop. A run the backend ACCEPTED but never streamed
  // (a wedged/rate-limited lane) is registered as "pending" at dispatch time.
  // If no first chunk arrives within firstChunkTimeoutMs, the watchdog tears it
  // down with a *retryable* error so the user isn't stuck on a blank thread.
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

      // Retryable broadcast.
      expect(broadcastNoFirstChunk).toHaveBeenCalledTimes(1);
      expect(broadcastNoFirstChunk.mock.calls[0]![0].sessionKey).toBe(basePending.sessionKey);

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

    it("processes multiple unstarted runs in one tick", async () => {
      runs.registerPending({
        ...basePending,
        sessionKey: "s-u1",
        submittedAt: 1_000_000,
        ws: fakeWs(),
      });
      runs.registerPending({
        ...basePending,
        sessionKey: "s-u2",
        submittedAt: 1_000_000,
        ws: fakeWs(),
      });

      await runWatchdogTick(deps);

      expect(broadcastNoFirstChunk).toHaveBeenCalledTimes(2);
      expect(writeAudit).toHaveBeenCalledTimes(2);
      const events = writeAudit.mock.calls.map((c) => c[0].eventType);
      expect(events).toEqual(["chat.run_no_first_chunk", "chat.run_no_first_chunk"]);
      expect(runs.size()).toBe(0);
    });

    it("continues processing other unstarted runs even if chatAbort throws for one", async () => {
      chatAbort.mockImplementation(async (sessionKey: string) => {
        if (sessionKey === "p1") throw new Error("OC gateway disconnected");
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

      // The audit row must still land for the abort-failed run — that's the
      // whole point of writing audit BEFORE the side effects.
      expect(writeAudit).toHaveBeenCalledTimes(2);
      expect(runs.size()).toBe(0);
    });

    it("continues processing other unstarted runs even if writeAudit throws for one", async () => {
      writeAudit.mockImplementation(async (entry: { detail: { sessionKey: string } }) => {
        if (entry.detail.sessionKey === "p1") throw new Error("audit DB down");
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

      // chatAbort and broadcastNoFirstChunk still fire for both — a failing
      // writeAudit for p1 must not poison the loop.
      expect(chatAbort).toHaveBeenCalledTimes(2);
      expect(broadcastNoFirstChunk).toHaveBeenCalledTimes(2);
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
      // The run started mid-teardown — leave it in the registry; OpenClaw now
      // owns liveness for started runs.
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

  describe("startRunWatchdog re-entrancy", () => {
    it("skips an overlapping tick while the previous one is still in flight", async () => {
      vi.useFakeTimers();
      try {
        const ws = fakeWs();
        // A pending run past the first-chunk timeout → the tick writeAudits + aborts.
        runs.registerPending({ ...basePending, submittedAt: 1_000_000, ws });

        // Make the first tick hang inside writeAudit so the next interval overlaps it.
        let resolveAudit: () => void = () => {};
        writeAudit.mockImplementationOnce(
          () =>
            new Promise<void>((r) => {
              resolveAudit = r;
            })
        );

        const stop = startRunWatchdog(deps, 1000);

        // First interval fires → tick starts and hangs in writeAudit.
        await vi.advanceTimersByTimeAsync(1000);
        // Second interval fires while the first tick is still awaiting writeAudit.
        await vi.advanceTimersByTimeAsync(1000);

        // The re-entrancy guard kept the second tick from re-processing the run
        // and writing a duplicate audit row.
        expect(writeAudit).toHaveBeenCalledTimes(1);

        resolveAudit();
        stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
