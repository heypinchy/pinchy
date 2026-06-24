/**
 * Wrap an async iterable so iteration stops early when `aborted` resolves,
 * instead of blocking forever on a producer that has gone silent.
 *
 * Motivation (#7): openclaw-node's `chat()` generator hangs indefinitely when
 * the OpenClaw WebSocket drops mid-stream — its internal "resolve next chunk"
 * promise is never settled, so the next `iterator.next()` never resolves. A
 * plain `for await` over it would block forever, so the consuming pipeStream's
 * `finally` (which clears the heartbeat interval and drops the ActiveRuns
 * entry) would never run, leaking a timer and a registry entry per dropped run.
 *
 * When `aborted` wins the race we run `onAbort` (so the caller can suppress the
 * misleading "stream completed" frames/audit) and return, which lets the
 * consumer's `finally` run. We also best-effort call the source iterator's
 * `return()` to let it release resources, but do NOT await it — the hung
 * generator's `return()` may itself never settle.
 */
export async function* iterateUntilAborted<T>(
  source: AsyncIterable<T>,
  aborted: Promise<void>,
  onAbort?: () => void
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  // A symbol sentinel the abort promise resolves to. An IteratorResult is an
  // object, so `typeof === "symbol"` cleanly distinguishes the abort winner
  // from any real chunk (and narrows the union for the type checker).
  const ABORTED = Symbol("aborted");
  const abortRace: Promise<typeof ABORTED> = aborted.then(() => ABORTED);
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), abortRace]);
      if (typeof next === "symbol") {
        onAbort?.();
        return;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.();
  }
}
