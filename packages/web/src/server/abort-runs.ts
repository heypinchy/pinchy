import type { AgentWaitResult, OpenClawClient } from "openclaw-node";
import type { ActiveRun, ActiveRuns } from "@/server/active-runs";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

/** The gateway's abort RPC, as `OpenClawClient.chatAbort` exposes it. */
export type ChatAbort = (sessionKey: string, runId?: string) => Promise<unknown>;

/** Why a run was stopped — the `reason` of its `chat.run_aborted` rows. */
export type AbortReason = "user_request" | "account_deactivated";

/** Who stopped a run and why: the actor and reason of its `chat.run_aborted` rows. */
export interface AbortRequest {
  actorId: string;
  reason: AbortReason;
}

/**
 * What the follow-up of an abort that stopped nothing needs (`pursueAbort`).
 */
export interface FollowUpDeps {
  /**
   * Send one `chat.abort` naming `runId`, and do nothing else. Deliberately NOT
   * `OpenClawClient.chatAbort`: that also ends whatever local `chat()` stream
   * is open on the session — by the time a follow-up runs, that can be the
   * user's NEXT turn, which a stale abort must never cut off.
   */
  abortRun: (sessionKey: string, runId: string) => Promise<unknown>;
  /**
   * OpenClaw's run-liveness oracle (`agent.wait`). Asked with `timeoutMs: 0`
   * after each follow-up that stopped nothing: a run that already ended needs
   * no further abort.
   */
  agentWait: (runId: string, opts: { timeoutMs: number }) => Promise<AgentWaitResult | undefined>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  now?: () => number;
}

/** Follow-up deps backed by the gateway client, looked up when first used. */
export function followUpDepsFor(
  client: () => Pick<OpenClawClient, "request" | "agentWait">
): FollowUpDeps {
  return {
    abortRun: async (sessionKey, runId) =>
      (await client().request("chat.abort", { sessionKey, runId })).payload,
    agentWait: (runId, opts) => client().agentWait(runId, opts),
  };
}

/**
 * Pauses between follow-up aborts: short at first, because a run OpenClaw is
 * only now accepting can reach a tool within seconds, then every 2 s.
 */
export const FOLLOW_UP_ABORT_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
/**
 * How long a follow-up keeps trying. OpenClaw accepts a dispatched run within
 * seconds or not at all; past this, the failed `chat.run_aborted` row stands.
 */
export const FOLLOW_UP_ABORT_DEADLINE_MS = 60_000;

export interface SessionAbortResult {
  /** The run that was in flight, or undefined when nothing was. */
  run: ActiveRun | undefined;
  /** The gateway-issued runId the abort named — undefined for a pending run. */
  runId: string | undefined;
  outcome: "success" | "failure";
}

/**
 * Stop the run in flight on `sessionKey` (#550) — the stop button's mechanics,
 * shared with deactivation (`abortRunsOfUser`).
 *
 * Calls `chatAbort` with the runId from the active-run registry when known
 * (precise — never aborts a newer run that already replaced this one on the
 * same session), falling back to a sessionKey-only abort otherwise. The stream
 * pipe for the aborted run handles the resulting synthetic terminal `done`
 * through the existing post-abort path — no extra teardown here.
 *
 * Reaches `chatAbort` even with nothing in flight (a safe no-op on the
 * gateway). Auditing this attempt is the caller's: it alone knows who asked
 * and why. `request` says so for the follow-up rows (`pursueAbort`), which
 * outlive the caller.
 *
 * When the abort named a started run and did not stop it, `followUp` keeps
 * trying by that runId (`pursueAbort`). A pending run gets the same once its
 * first chunk names it (`reAbortStartedRun`, from the stream pipe).
 */
export async function abortSessionRun(
  activeRuns: ActiveRuns,
  chatAbort: ChatAbort,
  sessionKey: string,
  options: { request?: AbortRequest; followUp?: FollowUpDeps } = {}
): Promise<SessionAbortResult> {
  // Mark BEFORE the RPC, not after (#978). OpenClaw answers `chat.abort` and
  // surfaces the abort into the stream as an error independently, and the
  // stream pipe is a different async context — awaiting the RPC first leaves
  // a window where the error chunk arrives while the run still looks healthy,
  // and the whole point is that the pipe can recognise it.
  const run = activeRuns.markUserAborted(sessionKey);
  // The first stop names who asked; a second one does not rewrite it.
  if (run && options.request && !run.abortRequest) run.abortRequest = options.request;
  // A PENDING run's runId is provisional — Pinchy's per-turn messageId, which
  // the gateway has never seen (`registerPending`; reconciled to the real one
  // by `markFirstChunk`). Handing it to `chatAbort` would name a run the
  // gateway cannot find, so it would abort NOTHING while the stop button
  // clears client-side: the reply streams on and the UI lies. Omitting it
  // aborts the session's current run instead — what the user actually asked
  // for. Same gate as `livenessRunId` in `handleHistory`.
  const runId = run && run.firstChunkAt !== null ? run.runId : undefined;

  // With nothing in flight, "stopped nothing" is the right answer, not a
  // failed abort — the stop button sends it anyway so it is never a silent
  // no-op, and an unreachable gateway is still a failure.
  const answer = requestAbort(chatAbort, sessionKey, runId, { inFlight: run !== undefined });
  if (run) recordAbortAttempt(run, answer);
  const outcome = await answer;
  if (run && runId !== undefined && outcome === "failure" && options.followUp) {
    pursueAbort(run, sessionKey, runId, options.followUp, { immediate: false });
  }
  return { run, runId, outcome };
}

/**
 * Send one `chat.abort` and read the gateway's answer as an outcome. Never
 * throws: an unreachable gateway is a `failure`, like any abort that did not
 * stop anything.
 */
async function requestAbort(
  chatAbort: ChatAbort,
  sessionKey: string,
  runId: string | undefined,
  { inFlight, quiet = false }: { inFlight: boolean; quiet?: boolean }
): Promise<"success" | "failure"> {
  try {
    const res = (await chatAbort(sessionKey, runId)) as { aborted?: unknown } | undefined;
    // The gateway answers `{ ok, aborted, runIds }`. `ok: true` only means it
    // understood the call — `aborted: false` means it stopped NOTHING, which
    // is the openclaw#42172 failure mode (the reply streams on while the
    // composer clears). A non-throwing call is therefore NOT proof of an
    // abort, and recording one as success made a lying stop button
    // indistinguishable from a working one in the trail.
    // A gateway that reports no payload (older builds) stays `success`: we
    // cannot tell, and a made-up failure is as dishonest as a made-up success.
    // Gated on `inFlight`: a stop click with nothing in flight answers
    // `aborted: false` too, and the stop button deliberately neither audits
    // nor logs that — warning here would reopen exactly the "aborted nothing"
    // spam vector a buggy or hostile client could exploit.
    if (inFlight && res?.aborted === false) {
      if (!quiet) {
        console.warn(
          `[abort-runs] gateway reported no run aborted for ${sessionKey} (runId=${runId ?? "none"})`
        );
      }
      return "failure";
    }
    return "success";
  } catch (err) {
    if (!quiet) {
      console.warn(
        `[abort-runs] chatAbort failed for ${sessionKey}:`,
        err instanceof Error ? err.message : err
      );
    }
    return "failure";
  }
}

/**
 * Note an abort sent for `run` on the run itself, so anyone can ask whether it
 * took effect (`abortTookEffect`) while the answer is still on its way —
 * OpenClaw ends an aborted run's stream and answers the RPC independently.
 * Any confirmed attempt confirms the run: two answers can cross, and a later
 * "stopped nothing" for a run an earlier abort already stopped is not news.
 */
function recordAbortAttempt(run: ActiveRun, answer: Promise<"success" | "failure">): void {
  const settled = answer.then((outcome) => {
    if (outcome === "success") run.abortConfirmed = true;
  });
  const earlier = run.abortSettled;
  run.abortSettled = earlier ? Promise.all([earlier, settled]).then(() => undefined) : settled;
}

/**
 * Did stopping `run` work? False for a run nobody stopped, and for one whose
 * every abort so far failed. Waits for aborts still in flight.
 */
export async function abortTookEffect(run: ActiveRun): Promise<boolean> {
  if (!run.abortedByUser) return false;
  await run.abortSettled;
  return run.abortConfirmed === true;
}

/**
 * Abort a stopped run again by its real runId, once its first chunk has named
 * it.
 *
 * A PENDING run is aborted by session only (see `abortSessionRun`). When
 * OpenClaw has not accepted it yet — the dispatch is still on its way, or
 * OpenClaw is still preparing it — that abort finds nothing and answers
 * `aborted: false`, and the run then starts anyway, tools included. That
 * first chunk is usually not OpenClaw's at all: openclaw-node ends the local
 * stream the moment `chatAbort` is called and yields a plain `done` carrying
 * the run's id. So the follow-up cannot wait for OpenClaw; it keeps trying
 * (`pursueAbort`) until an abort is confirmed or OpenClaw reports the run over.
 *
 * Returns the follow-up, also kept on `run.abortFollowUp`.
 */
export function reAbortStartedRun(
  run: ActiveRun,
  sessionKey: string,
  runId: string,
  followUp: FollowUpDeps
): Promise<void> {
  return pursueAbort(run, sessionKey, runId, followUp, { immediate: true });
}

/**
 * Keep aborting `run` by `runId` until one abort is confirmed, OpenClaw
 * reports the run over (`agent.wait`), or `FOLLOW_UP_ABORT_DEADLINE_MS`
 * passes. One follow-up per run; it runs detached from the stream, which by
 * now has ended (see `reAbortStartedRun`).
 *
 * Each attempt waits for the aborts already sent: when one of those turns out
 * to have worked, there is nothing left to do. Auditing, as `request`'s actor:
 *  - an attempt confirmed → a second `chat.run_aborted`, `outcome: success`,
 *    with the real runId and `followUp: "aborted_by_run_id"`, so a stop that
 *    took effect does not end the trail on the first attempt's `failure`;
 *  - OpenClaw reports the run finished normally (`status: "ok"`) → the reply
 *    completed with nobody receiving it: `chat.run_completed_after_disconnect`.
 */
function pursueAbort(
  run: ActiveRun,
  sessionKey: string,
  runId: string,
  deps: FollowUpDeps,
  { immediate }: { immediate: boolean }
): Promise<void> {
  if (run.abortFollowUp) return run.abortFollowUp;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + FOLLOW_UP_ABORT_DEADLINE_MS;

  const pursue = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 || !immediate) {
        if (now() >= deadline) {
          console.warn(
            `[abort-runs] gave up aborting ${runId} on ${sessionKey} after ` +
              `${FOLLOW_UP_ABORT_DEADLINE_MS / 1000}s: OpenClaw never confirmed an abort`
          );
          return;
        }
        const step = immediate ? attempt - 1 : attempt;
        await sleep(
          FOLLOW_UP_ABORT_DELAYS_MS[Math.min(step, FOLLOW_UP_ABORT_DELAYS_MS.length - 1)]
        );
      }
      if (await abortTookEffect(run)) return;

      const answer = requestAbort((key) => deps.abortRun(key, runId), sessionKey, runId, {
        inFlight: true,
        quiet: true,
      });
      recordAbortAttempt(run, answer);
      if ((await answer) === "success") {
        await auditFollowUpAbort(run, sessionKey, runId);
        return;
      }

      const ended = await runEnded(deps, runId);
      if (ended) {
        if (ended.status === "ok") await auditCompletedAnyway(run, sessionKey, runId);
        return;
      }
    }
  };

  run.abortFollowUp = pursue().catch((err) => {
    console.error(`[abort-runs] follow-up abort of ${runId} failed:`, err);
  });
  return run.abortFollowUp;
}

/** OpenClaw's terminal answer for `runId`, or null while it is not over (or unknown). */
async function runEnded(deps: FollowUpDeps, runId: string): Promise<AgentWaitResult | null> {
  try {
    const result = await deps.agentWait(runId, { timeoutMs: 0 });
    // Same reading as the reconnect liveness verdict: a terminal snapshot
    // carries `endedAt`; "timeout" without it only means the wait expired —
    // for a run OpenClaw has not accepted yet, exactly what we are waiting out.
    if (result && (result.status === "ok" || result.endedAt !== undefined)) return result;
    return null;
  } catch {
    // An unanswered oracle is not an ended run; keep trying until the deadline.
    return null;
  }
}

async function auditFollowUpAbort(run: ActiveRun, sessionKey: string, runId: string) {
  if (!run.abortRequest) return;
  await writeAudit({
    actorType: "user",
    actorId: run.abortRequest.actorId,
    eventType: "chat.run_aborted",
    resource: `agent:${run.agentId}`,
    detail: {
      agent: { id: run.agentId, name: run.agentName },
      sessionKey,
      runId,
      reason: run.abortRequest.reason,
      followUp: "aborted_by_run_id",
    },
    outcome: "success",
  });
}

async function auditCompletedAnyway(run: ActiveRun, sessionKey: string, runId: string) {
  await writeAudit({
    actorType: "user",
    actorId: run.userId,
    eventType: "chat.run_completed_after_disconnect",
    resource: `agent:${run.agentId}`,
    detail: {
      agent: { id: run.agentId, name: run.agentName },
      user: { id: run.userId },
      sessionKey,
      runId,
    },
    outcome: "success",
  });
}

/**
 * A stopped run the dispatch-race retry did not send again
 * (`chatWithDispatchRaceRetry`'s `shouldStop`). Nothing reached OpenClaw after
 * the stop, so the stop took effect even though its abort — sent while
 * nothing was running — answered "stopped nothing". Recorded as a second
 * `chat.run_aborted`, `outcome: success`, `followUp: "stopped_before_dispatch"`,
 * unless an abort was confirmed anyway (then the first row already says so).
 */
export async function auditStoppedBeforeDispatch(run: ActiveRun): Promise<void> {
  if (!run.abortRequest || (await abortTookEffect(run))) return;
  await writeAudit({
    actorType: "user",
    actorId: run.abortRequest.actorId,
    eventType: "chat.run_aborted",
    resource: `agent:${run.agentId}`,
    detail: {
      agent: { id: run.agentId, name: run.agentName },
      sessionKey: run.sessionKey,
      // No run reached OpenClaw, so there is no gateway runId to name.
      runId: null,
      reason: run.abortRequest.reason,
      followUp: "stopped_before_dispatch",
    },
    outcome: "success",
  });
}

/** Detached from any request: a failed write is recorded, never thrown. */
async function writeAudit(entry: Parameters<typeof appendAuditLog>[0]): Promise<void> {
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }
}

export interface AbortedRun {
  agent: { id: string; name: string };
  sessionKey: string;
  runId: string | undefined;
  outcome: "success" | "failure";
}

/**
 * Stop every chat run `userId` has in flight — deactivation's half of the
 * stop button.
 *
 * Closing a deactivated user's sockets (`user-sockets.ts`) only detaches them
 * as listeners: OpenClaw keeps executing a run it already accepted, tools and
 * all, until the run ends on its own. The registry knows every run Pinchy
 * dispatched for a browser chat and whose it is, so each one gets the same
 * `chat.abort` the stop button sends, and is marked the same way — the
 * abort's own error chunk then ends the turn instead of reading as a provider
 * failure. `requestedBy` is the admin, the actor of any follow-up row.
 *
 * Runs Pinchy did not start are out of its reach and not in the registry:
 * Telegram replies (OpenClaw's channel starts them) and automation runs
 * (tracked per email, not per user). The docs say what that leaves running.
 */
export async function abortRunsOfUser(
  userId: string,
  deps: {
    activeRuns: ActiveRuns;
    chatAbort: ChatAbort;
    requestedBy?: string;
    followUp?: FollowUpDeps;
  }
): Promise<AbortedRun[]> {
  // Snapshot first: an abort can finish a run and remove it from the registry
  // while this loop is still walking it.
  const theirs = [...deps.activeRuns.values()].filter((run) => run.userId === userId);
  const request: AbortRequest | undefined = deps.requestedBy
    ? { actorId: deps.requestedBy, reason: "account_deactivated" }
    : undefined;
  return Promise.all(
    theirs.map(async ({ sessionKey, agentId, agentName }) => {
      const { runId, outcome } = await abortSessionRun(
        deps.activeRuns,
        deps.chatAbort,
        sessionKey,
        { request, followUp: deps.followUp }
      );
      return { agent: { id: agentId, name: agentName }, sessionKey, runId, outcome };
    })
  );
}
