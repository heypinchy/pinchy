import { act } from "@testing-library/react";

/**
 * Drain every React update that is already queued — renders, effects, and the
 * state updates those effects schedule — and return once the tree has settled.
 *
 * This is the counterpart to `waitFor`, not a synonym for it, and the choice
 * between them is a correctness decision rather than a style one:
 *
 * - `waitFor` POLLS for something that has yet to happen. It is right for work
 *   whose arrival the test cannot force (a timer firing, a debounce elapsing).
 * - `flushPendingRenders` DRAINS work that is already pending. It is right when
 *   the test knows the update is queued and only needs it applied.
 *
 * Reaching for `waitFor` where a drain belongs is how load-dependent flakes are
 * born. A `waitFor` gated on one piece of state is satisfied by the FIRST
 * commit that shows it, so a second value arriving one commit later — the
 * classic "effect reads the clock and re-renders" shape — is left to macrotask
 * ordering: green in a warm run, red under preemption. Draining first makes the
 * assertion both deterministic and stricter, because it fails immediately with
 * the rendered DOM instead of after a timeout.
 *
 * ASSUMPTION worth knowing: this settles work that resolves through
 * MICROTASKS — an already-resolved promise, a `mockResolvedValue`, a state
 * update cascading out of an effect. Work gated on a real timer is NOT drained;
 * advance the clock (`vi.advanceTimersByTimeAsync`) or poll with `waitFor`
 * instead. A mock rewritten to resolve on a macrotask therefore turns such a
 * test red deterministically rather than flaky, which is the failure mode to
 * prefer.
 */
export async function flushPendingRenders(): Promise<void> {
  await act(async () => {});
}
