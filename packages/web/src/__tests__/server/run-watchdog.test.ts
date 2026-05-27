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
const baseRun = {
  runId: "run-1",
  sessionKey: "agent:a1:direct:u1",
  agentId: "a1",
  userId: "u1",
  agentName: "Smithers",
  startedAt: 1_000_000,
};

describe("runWatchdogTick", () => {
  let runs: ActiveRuns;
  let chatAbort: ReturnType<typeof vi.fn>;
  let writeAudit: ReturnType<typeof vi.fn>;
  let broadcastTimeout: ReturnType<typeof vi.fn>;
  let deps: WatchdogDeps;

  beforeEach(() => {
    runs = new ActiveRuns();
    chatAbort = vi.fn().mockResolvedValue(undefined);
    writeAudit = vi.fn().mockResolvedValue(undefined);
    broadcastTimeout = vi.fn();
    deps = {
      activeRuns: runs,
      chatAbort,
      writeAudit,
      broadcastTimeout,
      now: () => 1_000_000 + FIFTEEN_MIN + 1,
      maxRunDurationMs: FIFTEEN_MIN,
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
});
