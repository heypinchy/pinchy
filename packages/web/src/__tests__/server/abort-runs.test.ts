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
import { describe, it, expect, vi } from "vitest";
import type { WebSocket } from "ws";
import { ActiveRuns } from "@/server/active-runs";
import {
  abortRunsOfUser,
  abortSessionRun,
  abortTookEffect,
  reAbortStartedRun,
} from "@/server/abort-runs";

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
  // Whether a run that was stopped really stopped — the question
  // `chat.run_completed_after_disconnect` has to answer before it stays quiet.
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
    const chatAbort = vi.fn().mockResolvedValue({ ok: true, aborted: true });

    reAbortStartedRun(run, chatAbort, "s1", "run-real");

    expect(chatAbort).toHaveBeenCalledWith("s1", "run-real");
    expect(await abortTookEffect(run)).toBe(true);
  });

  it("asks nothing when the first abort was already confirmed", async () => {
    const runs = new ActiveRuns();
    pendingRun(runs, "s1", "u1");
    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: true }), "s1");
    runs.markFirstChunk("s1", 2_000, "run-real");
    const chatAbort = vi.fn();

    reAbortStartedRun(runs.get("s1")!, chatAbort, "s1", "run-real");

    expect(chatAbort).not.toHaveBeenCalled();
  });

  it("keeps a confirmed first abort confirmed when the follow-up stops nothing", async () => {
    // The two answers can cross: the follow-up is sent before the first one
    // came back. Any abort that stopped the run means the run was stopped.
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

    reAbortStartedRun(
      run,
      vi.fn().mockResolvedValue({ ok: true, aborted: false }),
      "s1",
      "run-real"
    );
    answerFirst({ ok: true, aborted: true });
    await first;

    expect(await abortTookEffect(run)).toBe(true);
  });

  it("leaves the run unconfirmed when the follow-up fails too", async () => {
    const runs = new ActiveRuns();
    pendingRun(runs, "s1", "u1");
    await abortSessionRun(runs, vi.fn().mockResolvedValue({ ok: true, aborted: false }), "s1");
    runs.markFirstChunk("s1", 2_000, "run-real");
    const run = runs.get("s1")!;

    reAbortStartedRun(run, vi.fn().mockRejectedValue(new Error("gateway down")), "s1", "run-real");

    expect(await abortTookEffect(run)).toBe(false);
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
