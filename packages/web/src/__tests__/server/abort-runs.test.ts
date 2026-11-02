/**
 * Stopping runs on OpenClaw from the server side.
 *
 * `abortSessionRun` is the stop button's mechanics, lifted out of
 * ClientRouter.handleAbort so deactivation can reuse them unchanged
 * (client-router-abort*.test.ts still pin the button through the router).
 * `abortRunsOfUser` is what deactivation adds: closing a deactivated user's
 * sockets only detaches them as listeners, while OpenClaw keeps executing the
 * run — tools included — until it ends on its own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebSocket } from "ws";

const { mockAppendAuditLog } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("@/lib/audit-deferred", () => ({ recordAuditFailure: vi.fn() }));

import { ActiveRuns } from "@/server/active-runs";
import {
  FOLLOW_UP_ABORT_DEADLINE_MS,
  abortRunsOfUser,
  abortSessionRun,
  abortTookEffect,
  reAbortStartedRun,
  type FollowUpDeps,
} from "@/server/abort-runs";

beforeEach(() => {
  mockAppendAuditLog.mockClear();
});

/**
 * Follow-up deps with a clock the test owns: `sleep` records each pause and
 * moves `now` forward by it, so the 60 s deadline costs no real time.
 */
function followUp(overrides: Partial<FollowUpDeps> = {}) {
  let clock = 0;
  const delays: number[] = [];
  const deps: FollowUpDeps = {
    abortRun: vi.fn().mockResolvedValue({ ok: true, aborted: true }),
    agentWait: vi.fn().mockResolvedValue({ status: "timeout", timeoutPhase: "queue" }),
    sleep: vi.fn(async (ms: number) => {
      delays.push(ms);
      clock += ms;
    }),
    now: () => clock,
    ...overrides,
  };
  return { deps, delays };
}

function auditRows(eventType: string) {
  return mockAppendAuditLog.mock.calls
    .map(
      (c) =>
        c[0] as {
          eventType: string;
          actorId: string;
          detail: Record<string, unknown>;
          outcome: string;
        }
    )
    .filter((row) => row.eventType === eventType);
}

const ws = {} as WebSocket;

function pendingRun(runs: ActiveRuns, sessionKey: string, userId: string, agentId = "agent-1") {
  return runs.registerPending({
    runId: `pending-${sessionKey}`,
    sessionKey,
    agentId,
    userId,
    agentName: `Agent ${agentId}`,
    submittedAt: 1_000,
    currentMessageId: "msg-1",
    ws,
  });
}

function startedRun(runs: ActiveRuns, sessionKey: string, userId: string, agentId = "agent-1") {
  pendingRun(runs, sessionKey, userId, agentId);
  runs.markFirstChunk(sessionKey, 2_000, `run-${sessionKey}`);
  return runs.get(sessionKey)!;
}

describe("abortSessionRun", () => {
  it("names a started run by its gateway runId and marks it as stopped", async () => {
    const runs = new ActiveRuns();
    startedRun(runs, "agent:a:direct:u1", "u1");
    const chatAbort = vi.fn().mockResolvedValue({ ok: true, aborted: true });

    const result = await abortSessionRun(runs, chatAbort, "agent:a:direct:u1");

    expect(chatAbort).toHaveBeenCalledWith("agent:a:direct:u1", "run-agent:a:direct:u1");
    expect(result.outcome).toBe("success");
    expect(result.runId).toBe("run-agent:a:direct:u1");
    expect(runs.get("agent:a:direct:u1")?.abortedByUser).toBe(true);
  });

  it("aborts a pending run by session, never by its provisional id", async () => {
    const runs = new ActiveRuns();
    pendingRun(runs, "agent:a:direct:u1", "u1");
    const chatAbort = vi.fn().mockResolvedValue(undefined);

    const result = await abortSessionRun(runs, chatAbort, "agent:a:direct:u1");

    expect(chatAbort).toHaveBeenCalledWith("agent:a:direct:u1", undefined);
    expect(result.runId).toBeUndefined();
    expect(result.outcome).toBe("success");
  });

  it("reports a failure when the gateway stopped nothing or could not be reached", async () => {
    const runs = new ActiveRuns();
    startedRun(runs, "s1", "u1");
    startedRun(runs, "s2", "u1");

    const nothing = await abortSessionRun(
      runs,
      vi.fn().mockResolvedValue({ ok: true, aborted: false }),
      "s1"
    );
    const unreachable = await abortSessionRun(
      runs,
      vi.fn().mockRejectedValue(new Error("gateway down")),
      "s2"
    );

    expect(nothing.outcome).toBe("failure");
    expect(unreachable.outcome).toBe("failure");
  });
});

describe("abortTookEffect", () => {
  // Whether a run that was stopped really stopped — the question every
  // follow-up asks before it sends another abort or writes a row.
  it("is false for a run nobody stopped", async () => {
    const runs = new ActiveRuns();
    const run = startedRun(runs, "s1", "u1");

    expect(await abortTookEffect(run)).toBe(false);
  });

  it("is true once the gateway confirmed the abort", async () => {
    const runs = new ActiveRuns();
    const run = startedRun(runs, "s1", "u1");

    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: true }), "s1");

    expect(await abortTookEffect(run)).toBe(true);
  });

  it("is false when the abort threw or the gateway stopped nothing", async () => {
    const runs = new ActiveRuns();
    const thrown = startedRun(runs, "s1", "u1");
    const nothing = startedRun(runs, "s2", "u1");

    await abortSessionRun(runs, vi.fn().mockRejectedValue(new Error("gateway down")), "s1");
    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: false }), "s2");

    expect(await abortTookEffect(thrown)).toBe(false);
    expect(await abortTookEffect(nothing)).toBe(false);
  });

  it("waits for an abort the gateway has not answered yet", async () => {
    const runs = new ActiveRuns();
    const run = startedRun(runs, "s1", "u1");
    let answer!: (res: unknown) => void;
    const aborting = abortSessionRun(
      runs,
      vi.fn(() => new Promise((r) => (answer = r))),
      "s1"
    );

    const verdict = abortTookEffect(run);
    answer({ ok: true, aborted: true });
    await aborting;

    expect(await verdict).toBe(true);
  });
});

describe("reAbortStartedRun", () => {
  // A pending run is aborted by session only; if OpenClaw had not started it
  // yet, that stopped nothing. Once its first chunk names the real runId, the
  // stream pipe aborts it again — by that runId.
  it("aborts by the real runId when the first abort stopped nothing, and records the verdict", async () => {
    const runs = new ActiveRuns();
    pendingRun(runs, "s1", "u1");
    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: false }), "s1");
    runs.markFirstChunk("s1", 2_000, "run-real");
    const run = runs.get("s1")!;
    const { deps } = followUp();

    await reAbortStartedRun(run, "s1", "run-real", deps);

    expect(deps.abortRun).toHaveBeenCalledWith("s1", "run-real");
    expect(await abortTookEffect(run)).toBe(true);
  });

  it("asks nothing when the first abort was already confirmed", async () => {
    const runs = new ActiveRuns();
    pendingRun(runs, "s1", "u1");
    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: true }), "s1");
    runs.markFirstChunk("s1", 2_000, "run-real");
    const { deps } = followUp();

    await reAbortStartedRun(runs.get("s1")!, "s1", "run-real", deps);

    expect(deps.abortRun).not.toHaveBeenCalled();
  });

  it("keeps a confirmed first abort confirmed, and asks nothing more, when its answer comes after the first chunk", async () => {
    // openclaw-node ends the local stream the moment `chatAbort` is called, so
    // the first chunk (its post-abort `done`) arrives before OpenClaw answered.
    // The follow-up waits for that answer: any abort that stopped the run means
    // the run was stopped.
    const runs = new ActiveRuns();
    pendingRun(runs, "s1", "u1");
    let answerFirst!: (res: unknown) => void;
    const first = abortSessionRun(
      runs,
      vi.fn(() => new Promise((r) => (answerFirst = r))),
      "s1"
    );
    runs.markFirstChunk("s1", 2_000, "run-real");
    const run = runs.get("s1")!;
    const { deps } = followUp({
      abortRun: vi.fn().mockResolvedValue({ ok: true, aborted: false }),
    });

    const following = reAbortStartedRun(run, "s1", "run-real", deps);
    answerFirst({ ok: true, aborted: true });
    await first;
    await following;

    expect(await abortTookEffect(run)).toBe(true);
    expect(deps.abortRun).not.toHaveBeenCalled();
  });

  it("leaves the run unconfirmed when the follow-up fails too", async () => {
    const runs = new ActiveRuns();
    pendingRun(runs, "s1", "u1");
    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: false }), "s1");
    runs.markFirstChunk("s1", 2_000, "run-real");
    const run = runs.get("s1")!;
    const { deps } = followUp({ abortRun: vi.fn().mockRejectedValue(new Error("gateway down")) });

    await reAbortStartedRun(run, "s1", "run-real", deps);

    expect(await abortTookEffect(run)).toBe(false);
  });

  describe("when OpenClaw accepts the run only after the early aborts", () => {
    // OpenClaw awaits attachments, the session store and work admission before
    // it registers a run; until then `chat.abort` finds nothing — by session or
    // by runId — and leaves no tombstone. So the follow-up keeps asking.
    async function stoppedPendingRun() {
      const runs = new ActiveRuns();
      pendingRun(runs, "s1", "u1");
      await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: false }), "s1", {
        request: { actorId: "admin-1", reason: "account_deactivated" },
      });
      runs.markFirstChunk("s1", 2_000, "run-real");
      return runs.get("s1")!;
    }

    it("keeps aborting by runId with a growing pause until an abort is confirmed, and records it", async () => {
      const run = await stoppedPendingRun();
      const notYet = { ok: true, aborted: false, runIds: [] };
      const { deps, delays } = followUp({
        abortRun: vi
          .fn()
          .mockResolvedValueOnce(notYet)
          .mockResolvedValueOnce(notYet)
          .mockResolvedValueOnce(notYet)
          .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["run-real"] }),
      });

      await reAbortStartedRun(run, "s1", "run-real", deps);

      expect(deps.abortRun).toHaveBeenCalledTimes(4);
      expect(
        vi.mocked(deps.abortRun).mock.calls.every((c) => c[0] === "s1" && c[1] === "run-real")
      ).toBe(true);
      // The first follow-up goes out at once; then 250 ms, 500 ms, 1 s.
      expect(delays).toEqual([250, 500, 1_000]);
      expect(await abortTookEffect(run)).toBe(true);
      // The stop took effect after all: the trail must not end on the first
      // attempt's failure.
      expect(auditRows("chat.run_aborted")).toEqual([
        expect.objectContaining({
          actorId: "admin-1",
          outcome: "success",
          detail: {
            agent: { id: "agent-1", name: "Agent agent-1" },
            sessionKey: "s1",
            runId: "run-real",
            reason: "account_deactivated",
            followUp: "aborted_by_run_id",
          },
        }),
      ]);
    });

    it("stops once OpenClaw reports the run over, and records a reply that finished anyway", async () => {
      const run = await stoppedPendingRun();
      const { deps } = followUp({
        abortRun: vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] }),
        agentWait: vi
          .fn()
          .mockResolvedValueOnce({ status: "timeout", timeoutPhase: "queue" })
          .mockResolvedValueOnce({ status: "ok", endedAt: 9_000 }),
      });

      await reAbortStartedRun(run, "s1", "run-real", deps);

      expect(deps.abortRun).toHaveBeenCalledTimes(2);
      expect(deps.agentWait).toHaveBeenCalledWith("run-real", { timeoutMs: 0 });
      expect(await abortTookEffect(run)).toBe(false);
      expect(auditRows("chat.run_aborted")).toEqual([]);
      expect(auditRows("chat.run_completed_after_disconnect")).toEqual([
        expect.objectContaining({
          actorId: "u1",
          outcome: "success",
          detail: {
            agent: { id: "agent-1", name: "Agent agent-1" },
            user: { id: "u1" },
            sessionKey: "s1",
            runId: "run-real",
          },
        }),
      ]);
    });

    it("stops without a completed row when the run ended any other way", async () => {
      const run = await stoppedPendingRun();
      const { deps } = followUp({
        abortRun: vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] }),
        agentWait: vi.fn().mockResolvedValue({ status: "error", endedAt: 9_000 }),
      });

      await reAbortStartedRun(run, "s1", "run-real", deps);

      expect(deps.abortRun).toHaveBeenCalledTimes(1);
      expect(auditRows("chat.run_completed_after_disconnect")).toEqual([]);
    });

    it("gives up at the deadline, leaving the failed row as the last word", async () => {
      const run = await stoppedPendingRun();
      const { deps, delays } = followUp({
        abortRun: vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] }),
        // An oracle that does not answer is not an ended run.
        agentWait: vi.fn().mockRejectedValue(new Error("gateway down")),
      });

      await reAbortStartedRun(run, "s1", "run-real", deps);

      const waited = delays.reduce((a, b) => a + b, 0);
      expect(waited).toBeGreaterThanOrEqual(FOLLOW_UP_ABORT_DEADLINE_MS);
      expect(waited).toBeLessThan(FOLLOW_UP_ABORT_DEADLINE_MS + 2_000);
      expect(Math.max(...delays)).toBe(2_000);
      expect(await abortTookEffect(run)).toBe(false);
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("runs one follow-up per run, however often it is asked for", async () => {
      const run = await stoppedPendingRun();
      const { deps } = followUp({
        abortRun: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] })
          .mockResolvedValue({ ok: true, aborted: true, runIds: ["run-real"] }),
      });

      await Promise.all([
        reAbortStartedRun(run, "s1", "run-real", deps),
        reAbortStartedRun(run, "s1", "run-real", deps),
      ]);

      expect(deps.abortRun).toHaveBeenCalledTimes(2);
      expect(auditRows("chat.run_aborted")).toHaveLength(1);
    });
  });
});

describe("abortSessionRun's follow-up", () => {
  it("keeps aborting a started run by its runId when the abort stopped nothing", async () => {
    const runs = new ActiveRuns();
    const run = startedRun(runs, "s1", "u1");
    const { deps, delays } = followUp({
      abortRun: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] })
        .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["run-s1"] }),
    });

    const result = await abortSessionRun(
      runs,
      vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] }),
      "s1",
      { request: { actorId: "u1", reason: "user_request" }, followUp: deps }
    );
    expect(result.outcome).toBe("failure");
    await run.abortFollowUp;

    // Not at once: the abort that just failed named the same runId.
    expect(delays).toEqual([250, 500]);
    expect(deps.abortRun).toHaveBeenCalledWith("s1", "run-s1");
    expect(auditRows("chat.run_aborted")).toEqual([
      expect.objectContaining({
        actorId: "u1",
        outcome: "success",
        detail: expect.objectContaining({ runId: "run-s1", reason: "user_request" }),
      }),
    ]);
  });

  it("does not follow up a pending run by session — its first chunk names the run", async () => {
    const runs = new ActiveRuns();
    const run = pendingRun(runs, "s1", "u1");
    const { deps } = followUp();

    await abortSessionRun(
      runs,
      vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] }),
      "s1",
      { request: { actorId: "u1", reason: "user_request" }, followUp: deps }
    );

    expect(run.abortFollowUp).toBeUndefined();
    expect(deps.abortRun).not.toHaveBeenCalled();
  });

  it("does not follow up an abort that worked", async () => {
    const runs = new ActiveRuns();
    const run = startedRun(runs, "s1", "u1");
    const { deps } = followUp();

    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: true }), "s1", {
      followUp: deps,
    });

    expect(run.abortFollowUp).toBeUndefined();
  });
});

describe("abortRunsOfUser", () => {
  it("aborts every run the user has in flight and leaves other users' runs alone", async () => {
    const runs = new ActiveRuns();
    startedRun(runs, "agent:a:direct:leaver", "leaver", "a");
    pendingRun(runs, "agent:b:direct:leaver:chat-2", "leaver", "b");
    startedRun(runs, "agent:a:direct:stayer", "stayer", "a");
    const chatAbort = vi.fn().mockResolvedValue({ ok: true, aborted: true });

    const aborted = await abortRunsOfUser("leaver", { activeRuns: runs, chatAbort });

    expect(chatAbort).toHaveBeenCalledTimes(2);
    expect(chatAbort).toHaveBeenCalledWith("agent:a:direct:leaver", "run-agent:a:direct:leaver");
    expect(chatAbort).toHaveBeenCalledWith("agent:b:direct:leaver:chat-2", undefined);
    expect(chatAbort).not.toHaveBeenCalledWith("agent:a:direct:stayer", expect.anything());
    expect(runs.get("agent:a:direct:stayer")?.abortedByUser).toBe(false);

    expect(aborted).toEqual(
      expect.arrayContaining([
        {
          agent: { id: "a", name: "Agent a" },
          sessionKey: "agent:a:direct:leaver",
          runId: "run-agent:a:direct:leaver",
          outcome: "success",
        },
        {
          agent: { id: "b", name: "Agent b" },
          sessionKey: "agent:b:direct:leaver:chat-2",
          runId: undefined,
          outcome: "success",
        },
      ])
    );
    expect(aborted).toHaveLength(2);
  });

  it("does not ask the gateway anything when the user has nothing in flight", async () => {
    const runs = new ActiveRuns();
    startedRun(runs, "agent:a:direct:stayer", "stayer");
    const chatAbort = vi.fn();

    expect(await abortRunsOfUser("leaver", { activeRuns: runs, chatAbort })).toEqual([]);
    expect(chatAbort).not.toHaveBeenCalled();
  });

  it("follows up a run whose abort stopped nothing, as the admin who deactivated", async () => {
    const runs = new ActiveRuns();
    const run = startedRun(runs, "s1", "leaver");
    const { deps } = followUp();

    await abortRunsOfUser("leaver", {
      activeRuns: runs,
      chatAbort: vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] }),
      requestedBy: "admin-1",
      followUp: deps,
    });
    await run.abortFollowUp;

    expect(auditRows("chat.run_aborted")).toEqual([
      expect.objectContaining({
        actorId: "admin-1",
        outcome: "success",
        detail: expect.objectContaining({ runId: "run-s1", reason: "account_deactivated" }),
      }),
    ]);
  });

  it("keeps going when one abort fails, and reports which one", async () => {
    const runs = new ActiveRuns();
    startedRun(runs, "s1", "leaver", "a");
    startedRun(runs, "s2", "leaver", "b");
    const chatAbort = vi
      .fn()
      .mockImplementation(async (key: string) =>
        key === "s1" ? Promise.reject(new Error("gateway down")) : { ok: true, aborted: true }
      );

    const aborted = await abortRunsOfUser("leaver", { activeRuns: runs, chatAbort });

    expect(aborted.find((r) => r.sessionKey === "s1")?.outcome).toBe("failure");
    expect(aborted.find((r) => r.sessionKey === "s2")?.outcome).toBe("success");
  });
});
