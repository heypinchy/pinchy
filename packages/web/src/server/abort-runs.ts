import type { AgentWaitResult, OpenClawClient, ProtocolResponse } from "openclaw-node";
import type { ActiveRun, ActiveRuns } from "@/server/active-runs";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { auditChatId } from "@/lib/session-key";

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
  /**
   * Did OpenClaw turn the dispatch of `runId` away (`dispatchWasRejected`)? A
   * rejected dispatch never becomes a run, so `agent.wait` cannot report it
   * over; this is the only terminal answer there is.
   */
  dispatchRejected?: (runId: string) => boolean;
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
    dispatchRejected: (runId) => dispatchWasRejected(client(), runId),
  };
}

/**
 * The dispatches OpenClaw turned away, per client: request id → when.
 *
 * OpenClaw rejects an `agent` request during validation (an unknown agent id,
 * bad params) with `ok: false` on that request, before it creates any run —
 * so `agent.wait` for its runId (the request id: OpenClaw's
 * `runId = idempotencyKey`, which openclaw-node sets to the request id)
 * answers "not over yet" for good. openclaw-node turns that answer into the
 * `chat()` stream's error, but only while the stream is open, and stopping a
 * run ends the local stream at once — so for exactly the run a follow-up
 * chases, it is dropped. The client still emits every response it receives
 * (`protocol:response`), and that is read here.
 */
const dispatchRejections = new WeakMap<object, Map<string, number>>();

/**
 * Start recording the dispatches OpenClaw turns away on `client`. Called
 * before each dispatch, so a rejection can never arrive unrecorded; listens
 * once per client however often it is called. Bounded: a rejection older than
 * the follow-up deadline is forgotten as the next one is recorded.
 */
export function watchDispatchRejections(client: Pick<OpenClawClient, "on">): void {
  if (dispatchRejections.has(client)) return;
  const rejected = new Map<string, number>();
  dispatchRejections.set(client, rejected);
  client.on("protocol:response", (res: ProtocolResponse) => {
    if (res.ok) return;
    const now = Date.now();
    // Insertion order is time order: stop at the first one still recent.
    for (const [id, at] of rejected) {
      if (now - at <= FOLLOW_UP_ABORT_DEADLINE_MS) break;
      rejected.delete(id);
    }
    rejected.set(res.id, now);
  });
}

/** Did OpenClaw turn away the dispatch of `runId` on `client` (`watchDispatchRejections`)? */
export function dispatchWasRejected(client: object, runId: string): boolean {
  return dispatchRejections.get(client)?.has(runId) ?? false;
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
  /**
   * The run that was in flight, or undefined when nothing was — including a
   * run an earlier stop's abort turned out to have stopped. Callers record a
   * row only when it is set.
   */
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
  // A run that is no longer in flight (`isInFlight`) is treated like a click
  // with nothing in flight — not marked, not followed up and, by the callers,
  // not audited.
  //
  // Mark BEFORE the RPC, not after (#978). OpenClaw answers `chat.abort` and
  // surfaces the abort into the stream as an error independently, and the
  // stream pipe is a different async context — awaiting the RPC first leaves
  // a window where the error chunk arrives while the run still looks healthy,
  // and the whole point is that the pipe can recognise it.
  const current = activeRuns.get(sessionKey);
  const run = current && isInFlight(current) ? activeRuns.markUserAborted(sessionKey) : undefined;
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
  if (!run) return { run, runId, outcome: (await answer).outcome };

  // Taken before this attempt is recorded: the aborts already on their way.
  const earlier = run.abortSettled;
  const outcome = await recordAbortAttempt(run, answer, runId);
  // An earlier abort whose answer was still on its way when this one was sent
  // may have stopped the run — OpenClaw then answers this one `aborted: false`
  // because there is nothing left to stop. Once that earlier abort is
  // confirmed, the run is stopped and its sender records the stop: this
  // attempt is a stop with nothing in flight, like one landing a moment later
  // (`isInFlight`). A failed row after the confirmed one would read "the stop
  // was never confirmed". Bounded, so a gateway that never answers cannot hold
  // up a stop click or a deactivation request: past it, this failure stands
  // and is followed up as before.
  if (outcome === "failure" && earlier) {
    await settledWithin(earlier, EARLIER_ABORT_ANSWER_WAIT_MS);
    if (run.abortConfirmed === true) {
      return { run: undefined, runId: undefined, outcome: "success" };
    }
  }
  if (runId !== undefined && outcome === "failure" && options.followUp) {
    pursueAbort(run, sessionKey, runId, options.followUp, { immediate: false });
  }
  return { run, runId, outcome };
}

/**
 * How long a stop whose abort stopped nothing waits for the answer to an
 * earlier abort of the same run still on its way (`abortSessionRun`). That
 * answer is one RPC round trip behind; this only bounds a gateway that never
 * sends it.
 */
export const EARLIER_ABORT_ANSWER_WAIT_MS = 2_000;

/** Wait for `settled`, but no longer than `ms`. */
async function settledWithin(settled: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  try {
    await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is `run` still running on OpenClaw, as far as Pinchy knows — is there
 * anything for a stop to stop? Its registry entry outlives the run: the pipe
 * lets go of it only after delivering the run's files. Two things end it
 * before that:
 *  - OpenClaw ended its stream itself (`streamEnded`): the reply is over.
 *    Stopping it would turn its ordinary end into a "stop that stopped
 *    nothing" whose follow-up then reports the reply completed for nobody,
 *    while the tab that clicked had received all of it.
 *  - OpenClaw confirmed an abort of it (`abortConfirmed`): it is stopped. A
 *    second stop — deactivation, or a click in another tab — would get
 *    `aborted: false` and end the trail on a failed `chat.run_aborted`, which
 *    reads "the stop was never confirmed" when it was.
 * A run whose abort is not confirmed (it failed, or its answer is still on
 * its way) is still in flight: the next stop is sent. When that one stops
 * nothing and the abort still on its way turns out confirmed, it is reported
 * as a stop with nothing in flight after all (`abortSessionRun`).
 */
function isInFlight(run: ActiveRun): boolean {
  return !run.streamEnded && run.abortConfirmed !== true;
}

/**
 * The gateway's answer to one `chat.abort`: whether it stopped anything and,
 * when it says, which runs. `runIds` is undefined for a gateway that did not
 * say (older builds, or no payload at all).
 */
interface AbortAnswer {
  outcome: "success" | "failure";
  runIds?: string[];
}

/**
 * Send one `chat.abort` and read the gateway's answer. Never throws: an
 * unreachable gateway is a `failure`, like any abort that did not stop
 * anything.
 */
async function requestAbort(
  chatAbort: ChatAbort,
  sessionKey: string,
  runId: string | undefined,
  { inFlight, quiet = false }: { inFlight: boolean; quiet?: boolean }
): Promise<AbortAnswer> {
  try {
    const res = (await chatAbort(sessionKey, runId)) as
      { aborted?: unknown; runIds?: unknown } | undefined;
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
      return { outcome: "failure" };
    }
    // OpenClaw 2026.7.1 answers `{ ok, aborted, runIds }`: every run the call
    // stopped — for an abort by session, whoever's they are.
    const runIds = Array.isArray(res?.runIds)
      ? res.runIds.filter((id): id is string => typeof id === "string")
      : undefined;
    return { outcome: "success", runIds };
  } catch (err) {
    if (!quiet) {
      console.warn(
        `[abort-runs] chatAbort failed for ${sessionKey}:`,
        err instanceof Error ? err.message : err
      );
    }
    return { outcome: "failure" };
  }
}

/**
 * Note an abort sent for `run` on the run itself, so anyone can ask whether it
 * took effect (`abortTookEffect`) while the answer is still on its way —
 * OpenClaw ends an aborted run's stream and answers the RPC independently.
 * Two answers can cross, and a later "stopped nothing" for a run an earlier
 * abort already stopped is not news.
 *
 * Resolves to this attempt's verdict FOR THIS RUN, which its sender records.
 * `namedRunId` is the runId the abort named; an abort by runId stops only that
 * run, so OpenClaw's `aborted: true` is about it. An abort by session (a
 * pending run, `namedRunId` undefined) stops every run on the session, and its
 * `aborted: true` can be about another one — an earlier turn OpenClaw started
 * after that turn's own stop missed it. It confirms this run only when its
 * `runIds` include this run's real runId, known once the first chunk named it;
 * openclaw-node delivers that chunk before OpenClaw's answer arrives, because
 * it ends the local stream the moment the abort is sent. An answer naming runs
 * while this run's runId is still unknown confirms nothing yet; the follow-up
 * credits it once the runId shows up (`pursueAbort`).
 *
 * The verdict is in place — `abortConfirmed` included — before anyone waiting
 * on `abortSettled` resumes.
 */
function recordAbortAttempt(
  run: ActiveRun,
  answer: Promise<AbortAnswer>,
  namedRunId: string | undefined
): Promise<"success" | "failure"> {
  const verdict = answer.then(({ outcome, runIds }): "success" | "failure" => {
    if (outcome !== "success") return "failure";
    const stopped = (run.abortStoppedRunIds ??= new Set());
    if (namedRunId !== undefined) stopped.add(namedRunId);
    else if (runIds === undefined) run.abortStoppedUnnamed = true;
    else for (const id of runIds) stopped.add(id);
    const ownRunId = namedRunId ?? (run.firstChunkAt !== null ? run.runId : undefined);
    if (!abortStopped(run, ownRunId)) return "failure";
    run.abortConfirmed = true;
    return "success";
  });
  const settled = verdict.then(() => undefined);
  const earlier = run.abortSettled;
  run.abortSettled = earlier ? Promise.all([earlier, settled]).then(() => undefined) : settled;
  return verdict;
}

/** Did an answer to an abort sent for `run` say it stopped `runId`? */
function abortStopped(run: ActiveRun, runId: string | undefined): boolean {
  if (run.abortStoppedUnnamed) return true;
  return runId !== undefined && run.abortStoppedRunIds?.has(runId) === true;
}

/**
 * Did stopping `run` work — did OpenClaw confirm it stopped this run? False
 * for a run nobody stopped, for one whose every abort so far failed, and for
 * one whose abort by session stopped only other runs. Waits for aborts still
 * in flight.
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
 * Called again for the same turn when the dispatch-race retry sent it again
 * under a new runId (`ActiveRuns.switchRunId`): each runId gets its own.
 *
 * Returns the run's follow-ups (`run.abortFollowUp`).
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
 * passes — or OpenClaw turned the dispatch away (`dispatchRejected`), which
 * `agent.wait` never reports. One follow-up per runId; it runs detached from
 * the stream, which by now has ended (see `reAbortStartedRun`).
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
  const pursued = (run.abortFollowUpRunIds ??= new Set());
  if (pursued.has(runId)) return run.abortFollowUp ?? Promise.resolve();
  pursued.add(runId);
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
      // Asked of THIS runId, not of the run: a confirmation for another
      // attempt of the turn, or another run on the session, stops nothing here.
      await run.abortSettled;
      if (abortStopped(run, runId)) {
        // Stopped by an abort whose answer came before this runId was known,
        // so no row has said so yet.
        if (!run.abortConfirmed) {
          run.abortConfirmed = true;
          await auditFollowUpAbort(run, runId);
        }
        return;
      }
      // Turned away before it became a run: nothing will run, and nothing
      // else will ever say so.
      if (deps.dispatchRejected?.(runId)) return;

      const answer = requestAbort((key) => deps.abortRun(key, runId), sessionKey, runId, {
        inFlight: true,
        quiet: true,
      });
      if ((await recordAbortAttempt(run, answer, runId)) === "success") {
        await auditFollowUpAbort(run, runId);
        return;
      }

      const ended = await runEnded(deps, runId);
      if (ended) {
        if (ended.status === "ok") await auditCompletedAnyway(run, runId);
        return;
      }
    }
  };

  const followUp = pursue().catch((err) => {
    console.error(`[abort-runs] follow-up abort of ${runId} failed:`, err);
  });
  const earlier = run.abortFollowUp;
  run.abortFollowUp = earlier ? Promise.all([earlier, followUp]).then(() => undefined) : followUp;
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

/*
 * The rows below carry no `sessionKey`: a web-chat key is
 * `agent:<agentId>:direct:<userId>[:<chatId>]`, the run's user's raw id, and
 * `detail` is stored verbatim in an immutable, HMAC-chained row crypto-erasure
 * cannot reach (#824). The agent, the chat and the runId identify the run; the
 * actor is on the row, pseudonymized on write.
 */

async function auditFollowUpAbort(run: ActiveRun, runId: string) {
  if (!run.abortRequest) return;
  await writeAudit({
    actorType: "user",
    actorId: run.abortRequest.actorId,
    eventType: "chat.run_aborted",
    resource: `agent:${run.agentId}`,
    detail: {
      agent: { id: run.agentId, name: run.agentName },
      chatId: auditChatId(run.sessionKey),
      runId,
      reason: run.abortRequest.reason,
      followUp: "aborted_by_run_id",
    },
    outcome: "success",
  });
}

async function auditCompletedAnyway(run: ActiveRun, runId: string) {
  await writeAudit({
    actorType: "user",
    // The run's user, pseudonymized on write. Not repeated in `detail`, which
    // is stored verbatim and out of crypto-erasure's reach (#824).
    actorId: run.userId,
    eventType: "chat.run_completed_after_disconnect",
    resource: `agent:${run.agentId}`,
    detail: {
      agent: { id: run.agentId, name: run.agentName },
      chatId: auditChatId(run.sessionKey),
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
      chatId: auditChatId(run.sessionKey),
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
  // while this loop is still walking it. A run no longer in flight
  // (`isInFlight`: its reply ended, or its stop was confirmed) has nothing to
  // stop or report.
  const theirs = [...deps.activeRuns.values()].filter(
    (run) => run.userId === userId && isInFlight(run)
  );
  const request: AbortRequest | undefined = deps.requestedBy
    ? { actorId: deps.requestedBy, reason: "account_deactivated" }
    : undefined;
  return Promise.all(
    theirs.map(async ({ sessionKey, agentId, agentName }) => {
      const { run, runId, outcome } = await abortSessionRun(
        deps.activeRuns,
        deps.chatAbort,
        sessionKey,
        { request, followUp: deps.followUp }
      );
      // No longer in flight by the time it was asked — its reply ended, or an
      // earlier stop's abort was confirmed: nothing to report.
      if (!run) return [];
      return [{ agent: { id: agentId, name: agentName }, sessionKey, runId, outcome }];
    })
  ).then((perRun) => perRun.flat());
}
