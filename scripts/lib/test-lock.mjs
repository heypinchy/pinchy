/**
 * Decides who may run the full vitest suite right now, so that two sessions on
 * this machine do not run it at the same time.
 *
 * WHY SERIALIZE AT ALL — measured on this repo, on a 14-core machine:
 *
 *   one full `pnpm test`     14–16 processes, ~4 GB peak,  55s
 *   two at the same time     54 processes,   ~10 GB peak,  unfinished after 10min
 *
 * That is not a factor of two, it is at least a factor of eleven, and it is not
 * explained by memory alone: vitest asks `availableParallelism()` and gets 14
 * regardless of how many other sessions are doing the same thing, so every run
 * assumes it owns the machine. Two runs oversubscribe the cores threefold while
 * each holds its own heaps, and the box thrashes. Serialized, the same two runs
 * cost 110s instead of 600+.
 *
 * The obvious alternative — turning vitest's own knobs down — was measured and
 * does not work. `--maxWorkers=4` made BOTH numbers worse (4982 MB, 204s) because
 * vitest reuses a worker across files and its heap grows monotonically, so fewer
 * workers means more files per worker. `pool: "threads"` turns jsdom tests red.
 * Capping the per-fork heap buys ~15% for ~11% more wall clock. There is no
 * meaningful saving inside a run; the saving is in not overlapping runs.
 *
 * FAIL OPEN, ALWAYS. The worst thing this mechanism may do is make a test run
 * slow. It must never make one impossible — so an unreadable lock, a holder that
 * died, a clock that jumped, or simply too long a wait all end with the suite
 * running. Every branch below is written to that rule.
 */

/**
 * How long a lock may exist before we assume its owner is gone regardless of
 * what the OS says about its pid.
 *
 * `process.kill(pid, 0)` only proves that SOME process owns that number — pids
 * are recycled, and a lock file that outlived a reboot can easily name a pid
 * that now belongs to something unrelated. A full suite takes ~1min unloaded and
 * a few minutes under load, so 20 minutes is far beyond any real run while still
 * bounding the damage a recycled pid can do.
 */
export const MAX_LOCK_AGE_MS = 20 * 60 * 1000;

/**
 * How long we queue behind live holders before running anyway.
 *
 * With several sessions queued this is reached only when something is genuinely
 * wrong, and at that point blocking is the worse failure: an agent that cannot
 * run its tests is stuck, an agent whose tests are slow is merely slow.
 */
export const MAX_WAIT_MS = 20 * 60 * 1000;

/** Tab-separated: a label may contain spaces, the other two fields cannot. */
export function formatLockRecord({ pid, startedAtMs, label }) {
  return `${pid}\t${startedAtMs}\t${label ?? ""}\n`;
}

/**
 * @returns {{pid: number, startedAtMs: number, label: string} | null} null for
 *   anything that is not a complete, numeric record. Null means "nobody holds
 *   this" — corrupt bytes must never park a session behind a phantom holder.
 */
export function parseLockRecord(text) {
  if (typeof text !== "string") return null;
  const [pid, startedAtMs, ...rest] = text.trim().split("\t");
  const parsedPid = Number.parseInt(pid, 10);
  const parsedStart = Number.parseInt(startedAtMs, 10);
  if (!Number.isFinite(parsedPid) || !Number.isFinite(parsedStart)) return null;
  return {
    pid: parsedPid,
    startedAtMs: parsedStart,
    label: rest.join("\t").trim(),
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<parseLockRecord>} opts.record current holder, or null
 * @param {number} opts.now epoch ms
 * @param {(pid: number) => boolean} opts.isAlive process-liveness probe
 * @param {number} opts.waitedMs how long this caller has already queued
 * @returns {{action: "acquire"|"steal"|"wait"|"proceed", reason: string}}
 */
export function decideLockAction({
  record,
  now,
  isAlive,
  waitedMs,
  maxAgeMs = MAX_LOCK_AGE_MS,
  maxWaitMs = MAX_WAIT_MS,
}) {
  if (record === null)
    return { action: "acquire", reason: "no other run holds the lock" };

  if (!isAlive(record.pid))
    return {
      action: "steal",
      reason: `pid ${record.pid} is no longer running`,
    };

  // A backwards clock jump (NTP, a resumed laptop) yields a negative age. That
  // is not "very old", so clamp rather than treat it as stale.
  const age = Math.max(0, now - record.startedAtMs);
  if (age > maxAgeMs)
    return {
      action: "steal",
      reason: `the lock is older than ${Math.round(maxAgeMs / 60000)} minutes`,
    };

  // Checked last on purpose: a dead or ancient holder is worth STEALING from
  // even after a long wait, because taking the lock keeps the next session
  // serialized. Proceeding unlocked would let the pile-up start again.
  if (waitedMs > maxWaitMs)
    return {
      action: "proceed",
      reason: `waited ${Math.round(waitedMs / 60000)} minutes — running anyway rather than blocking`,
    };

  return {
    action: "wait",
    reason: `pid ${record.pid}${record.label ? ` (${record.label})` : ""} is running the suite`,
  };
}

/**
 * Cases where serializing is wrong rather than merely unnecessary.
 *
 * PINCHY_TEST_LOCK_HELD is set for the child command, so a suite that shells out
 * to another `pnpm test` cannot deadlock against the lock its own parent holds.
 * CI runs one job per runner with nothing to serialize against, and a lock file
 * baked into an image must not cost a CI minute.
 */
export function shouldBypassLock(env = {}) {
  return Boolean(env.PINCHY_TEST_LOCK_HELD) || Boolean(env.CI);
}
