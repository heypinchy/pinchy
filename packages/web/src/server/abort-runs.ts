import type { ActiveRun, ActiveRuns } from "@/server/active-runs";

/** The gateway's abort RPC, as `OpenClawClient.chatAbort` exposes it. */
export type ChatAbort = (sessionKey: string, runId?: string) => Promise<unknown>;

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
 * gateway). Auditing is the caller's: it alone knows who asked and why.
 */
export async function abortSessionRun(
  activeRuns: ActiveRuns,
  chatAbort: ChatAbort,
  sessionKey: string
): Promise<SessionAbortResult> {
  // Mark BEFORE the RPC, not after (#978). OpenClaw answers `chat.abort` and
  // surfaces the abort into the stream as an error independently, and the
  // stream pipe is a different async context — awaiting the RPC first leaves
  // a window where the error chunk arrives while the run still looks healthy,
  // and the whole point is that the pipe can recognise it.
  const run = activeRuns.markUserAborted(sessionKey);
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
  return { run, runId, outcome: await answer };
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
    console.warn(
      `[abort-runs] chatAbort failed for ${sessionKey}:`,
      err instanceof Error ? err.message : err
    );
    return "failure";
  }
}

/**
 * Note an abort sent for `run` on the run itself, so the stream pipe can ask
 * whether it took effect (`abortTookEffect`) even when the stream ends before
 * the gateway answers — OpenClaw ends an aborted run's stream and answers the
 * RPC independently, and the `done` can win. Any confirmed attempt confirms
 * the run: two answers can cross, and a later "stopped nothing" for a run an
 * earlier abort already stopped is not news.
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
 * every abort failed — that run may well have finished, and saying otherwise
 * hides it. Waits for aborts still in flight.
 */
export async function abortTookEffect(run: ActiveRun): Promise<boolean> {
  if (!run.abortedByUser) return false;
  await run.abortSettled;
  return run.abortConfirmed === true;
}

/**
 * Abort a run again by its real runId, once its first chunk has named it.
 *
 * A PENDING run is aborted by session only (see `abortSessionRun`). When
 * OpenClaw has not started it yet — the dispatch is still on its way — that
 * abort finds nothing and answers `aborted: false`, and the run then starts
 * anyway. The stream pipe calls this when the first chunk reconciles a run
 * that was already stopped. Skipped when an earlier abort is already known to
 * have worked; otherwise sent at once rather than after the first answer, so
 * no tool gets the time to start. Not audited: the `chat.run_aborted` row for
 * the stop belongs to whoever asked for it, and a reply that finishes anyway
 * still surfaces as `chat.run_completed_after_disconnect` when nobody watched.
 */
export function reAbortStartedRun(
  run: ActiveRun,
  chatAbort: ChatAbort,
  sessionKey: string,
  runId: string
): void {
  if (run.abortConfirmed) return;
  // Quiet on `aborted: false`: the usual reason is that the first abort got
  // there after all and its answer has not come back yet.
  recordAbortAttempt(
    run,
    requestAbort(chatAbort, sessionKey, runId, { inFlight: true, quiet: true })
  );
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
 * failure.
 *
 * Runs Pinchy did not start are out of its reach and not in the registry:
 * Telegram replies (OpenClaw's channel starts them) and automation runs
 * (tracked per email, not per user). The docs say what that leaves running.
 */
export async function abortRunsOfUser(
  userId: string,
  deps: { activeRuns: ActiveRuns; chatAbort: ChatAbort }
): Promise<AbortedRun[]> {
  // Snapshot first: an abort can finish a run and remove it from the registry
  // while this loop is still walking it.
  const theirs = [...deps.activeRuns.values()].filter((run) => run.userId === userId);
  return Promise.all(
    theirs.map(async ({ sessionKey, agentId, agentName }) => {
      const { runId, outcome } = await abortSessionRun(deps.activeRuns, deps.chatAbort, sessionKey);
      return { agent: { id: agentId, name: agentName }, sessionKey, runId, outcome };
    })
  );
}
