// Deadline-bounded polling for E2E setup code. The exit condition belongs to
// the caller's probe, so it can be the very check the rest of setup relies on
// (agent-rules/testing.md § "No Untracked Sleeps In E2E"); the clock is injectable so the
// retry/deadline logic is unit-testable without waiting.

export type AttemptResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface PollOptions {
  deadlineMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type PollResult<T> =
  { ok: true; value: T; attempts: number } | { ok: false; reason: string; attempts: number };

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `attempt` until it succeeds or `deadlineMs` has elapsed. A throw counts as a failure. */
export async function pollUntil<T>(
  attempt: () => Promise<AttemptResult<T>>,
  { deadlineMs, intervalMs, now = Date.now, sleep = realSleep }: PollOptions
): Promise<PollResult<T>> {
  const start = now();
  let attempts = 0;
  let reason = "no attempt made";
  for (;;) {
    attempts++;
    try {
      const res = await attempt();
      if (res.ok) return { ok: true, value: res.value, attempts };
      reason = res.reason;
    } catch (err) {
      reason = describeError(err);
    }
    if (now() - start + intervalMs > deadlineMs) return { ok: false, reason, attempts };
    await sleep(intervalMs);
  }
}

export type SweepResult =
  { ok: true; candidate: string } | { ok: false; failures: Record<string, string> };

/**
 * Probes every candidate in order, repeating the whole sweep until one answers
 * or the deadline passes. On failure, reports each candidate's last reason.
 */
export async function sweepCandidatesUntil(
  candidates: string[],
  probe: (candidate: string) => Promise<{ ok: true } | { ok: false; reason: string }>,
  options: PollOptions
): Promise<SweepResult> {
  const failures = new Map<string, string>();
  const res = await pollUntil(async () => {
    for (const candidate of candidates) {
      let result: { ok: true } | { ok: false; reason: string };
      try {
        result = await probe(candidate);
      } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) return { ok: true as const, value: candidate };
      failures.set(candidate, result.reason);
    }
    return { ok: false as const, reason: "no candidate reachable" };
  }, options);
  return res.ok
    ? { ok: true, candidate: res.value }
    : { ok: false, failures: Object.fromEntries(failures) };
}
