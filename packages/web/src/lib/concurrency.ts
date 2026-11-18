/**
 * Runs `tasks` with at most `concurrency` in flight at a time, preserving
 * result order. A worker pool of `min(concurrency, tasks.length)` workers
 * each pull the next unclaimed index and await it before pulling another, so
 * task N+1 never starts before some earlier task has finished (unlike a bare
 * `Promise.all`, which starts everything at once).
 *
 * Shared rather than duplicated per call site: the fan-out over N chats in
 * GET /api/agents/[agentId]/chats (one `sessions.history` RPC per unlabeled
 * chat) and the fan-out over Odoo model probes in `fetchOdooSchema` are the
 * same "bounded concurrent fan-out" shape, and letting the OpenClaw or Odoo
 * side of either one hang no longer costs the request 100+ simultaneous
 * in-flight RPCs.
 *
 * A non-positive `concurrency` is clamped to 1 rather than honoured: the pool
 * size is `min(concurrency, tasks.length)`, so a 0 would spawn no workers at
 * all and return a sparse array of `undefined` with nothing having run —
 * silent data loss where the caller asked for slow.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
