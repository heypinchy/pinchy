import { act, waitFor } from "@testing-library/react";

/**
 * The settle signal for a component that loads data asynchronously — what a
 * test waits on before it asserts that something is ABSENT.
 *
 *     const load = holdResults();
 *     mockGet.mockImplementation(() => load.resolveWith(data));
 *     render(<Component />);
 *     await load.release();
 *     expect(screen.queryByRole("alert")).not.toBeInTheDocument();
 *
 * The tempting wait is "the mock was called". It proves nothing: a mount
 * effect calls the mock synchronously inside `render()`'s act, so that wait
 * returns at once and the response -> setState -> commit chain is left racing
 * the assertion. A positive assertion merely flakes on that race. A negative
 * one is worse — it passes before the data has arrived and so tests nothing,
 * green whether or not the component is broken.
 *
 * "The first commit after the data arrived" is not enough either. State a
 * component derives from the data in a `useEffect` is applied in a LATER
 * Scheduler task, and waitFor's trailing `setTimeout(0)` can resolve before
 * it on a preempted worker — the derived warning is not there yet, and the
 * negative assertion passes on a component that would have rendered it.
 *
 * So the mock's result is HELD until the test releases it, and `release()`
 * settles it inside `act()`. Everything the outcome causes is then scheduled
 * on act's own queue rather than on React's Scheduler, and act drains that
 * queue — renders, passive effects, the updates those effects schedule, and
 * promise chains of any depth, up to a macrotask after its callback — before
 * it returns.
 *
 * GUARANTEE: when `release()` returns, every update the released outcome
 * caused through promises and effects is committed, including state derived
 * from it in effects. One outcome shape serves every case: a resolution that
 * re-renders, one equal to the initial state that commits nothing, and a
 * rejection the component swallows — "nothing to wait for" is still waited
 * for, because the release itself is the signal.
 *
 * NOT covered: work the outcome gates on a real timer (a debounce, a
 * `setTimeout` retry). Advance the clock for that.
 */
export function holdResults() {
  type Held = { settle: () => void; promise: Promise<unknown> };
  const pending: Held[] = [];
  let requested = 0;

  function hold<T>(outcome: { value: T } | { error: unknown }): Promise<T> {
    requested++;
    let settle!: () => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = () => ("error" in outcome ? reject(outcome.error) : resolve(outcome.value));
    });
    pending.push({ settle, promise });
    return promise;
  }

  return {
    /** Use as a mock's return value: resolves with `value` once released. */
    resolveWith<T>(value: T): Promise<T> {
      return hold({ value });
    },

    /** Use as a mock's return value: rejects with `error` once released. */
    rejectWith(error: unknown): Promise<never> {
      return hold<never>({ error });
    },

    /**
     * Wait until the component has requested the mocked data, then settle
     * every request held so far inside act() and return once everything they
     * caused is committed. A request issued while releasing stays held for
     * the next `release()`.
     */
    async release(): Promise<void> {
      await waitFor(() => {
        if (requested === 0) throw new Error("the component has not requested the mocked data");
        if (pending.length === 0) {
          throw new Error("every request so far has already been released — nothing new is held");
        }
      });
      await act(async () => {
        const batch = pending.splice(0);
        for (const held of batch) held.settle();
        // Registered after the component's own handlers, so it settles after them.
        await Promise.allSettled(batch.map((held) => held.promise));
      });
    },
  };
}
