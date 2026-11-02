import { Profiler, type ProfilerOnRenderCallback, type ReactElement } from "react";
import { act, waitFor } from "@testing-library/react";

/**
 * Settle signals for a component that loads data asynchronously — what a test
 * waits on before it asserts that something is ABSENT.
 *
 * The tempting wait is "the mock was called". It proves nothing: a mount effect
 * calls the mock synchronously inside `render()`'s act, so that wait returns at
 * once, and the response -> setState -> commit chain is left racing the
 * assertion. A positive assertion merely flakes on that race. A negative one is
 * worse — it passes before the data has arrived and so tests nothing at all,
 * green whether or not the component is broken.
 *
 * Two shapes, chosen by what the outcome does to the tree:
 *
 * - `trackDataApplied()` — the outcome changes state, so React COMMITS. Wait for
 *   the first commit after the mocked data was handed over. This is a positive
 *   signal tied to the data itself: an unrelated commit before it (a mount-time
 *   state update, a click's own render) does not count.
 *
 * - `holdResult()` — the outcome commits nothing (a rejection the component
 *   swallows, data equal to the initial state), so there is no commit to wait
 *   for. The result is held until the test releases it inside `act()`; act
 *   keeps its queue open until a macrotask after its callback, so every update
 *   the outcome schedules through promise chains of any depth is flushed before
 *   it returns. A canary that does render something for that outcome therefore
 *   shows up in the DOM by the time the assertion runs.
 */

/**
 * Track one or more mocked data deliveries and the commits that follow them.
 *
 *     const load = trackDataApplied();
 *     mockGet.mockImplementation(() => load.deliver(data));
 *     render(load.wrap(<Component />));
 *     await load.waitForApplied();
 *     expect(screen.queryByRole("alert")).not.toBeInTheDocument();
 *
 * Several deliveries (a mount fetch, then a click's request) are counted in
 * order: `waitForApplied()` waits until every delivery requested so far has
 * been handed over AND a commit has happened after the last of them.
 */
export function trackDataApplied() {
  let requested = 0;
  let delivered = 0;
  let appliedThrough = 0;

  const onRender: ProfilerOnRenderCallback = (_id, phase) => {
    if (phase !== "mount") appliedThrough = delivered;
  };

  return {
    /**
     * Use as a mock's return value. Counts the request at call time and hands
     * `value` over on the next microtask, recording the moment it did.
     */
    deliver<T>(value: T): Promise<T> {
      requested++;
      return Promise.resolve().then(() => {
        delivered++;
        return value;
      });
    },

    /** Wrap the tree under test so its commits are observed. */
    wrap(ui: ReactElement): ReactElement {
      return (
        <Profiler id="data-applied" onRender={onRender}>
          {ui}
        </Profiler>
      );
    },

    /** Wait for the commit that applied the latest delivered data. */
    async waitForApplied(): Promise<void> {
      await waitFor(() => {
        if (requested === 0) throw new Error("the component has not requested the mocked data");
        if (delivered < requested) throw new Error("the mocked data has not been handed over yet");
        if (appliedThrough < delivered) {
          throw new Error(
            "the mocked data was handed over, but no commit has applied it yet — if this outcome " +
              "changes no state, nothing will ever commit: use holdResult() instead"
          );
        }
      });
    },
  };
}

/**
 * A mocked async result the test releases explicitly, inside `act()`.
 *
 *     const result = holdResult<Status>();
 *     mockGet.mockReturnValue(result.promise);
 *     const { container } = render(<Component />);
 *     expect(mockGet).toHaveBeenCalled();
 *     await result.reject(new Error("network down"));
 *     expect(container).toBeEmptyDOMElement();
 */
export function holdResult<T>() {
  let resolveHeld!: (value: T) => void;
  let rejectHeld!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveHeld = resolve;
    rejectHeld = reject;
  });

  return {
    /** What the mock returns. Pending until `resolve` / `reject` is awaited. */
    promise,

    /** Resolve inside act and return once everything it caused is committed. */
    async resolve(value: T): Promise<void> {
      await act(async () => {
        resolveHeld(value);
        await promise;
      });
    },

    /** Reject inside act and return once everything it caused is committed. */
    async reject(error: unknown): Promise<void> {
      await act(async () => {
        rejectHeld(error);
        // Registered after the component's handlers, so it runs after them.
        await promise.catch(() => undefined);
      });
    },
  };
}
