import { _resetConfigPushState } from "@/lib/openclaw-config/push-state";

/**
 * What a Pinchy restart does to the process-wide config-push state
 * (push-state.ts, on globalThis): nothing of it survives, and its timers die
 * with the process. Call before `vi.resetModules()` to simulate one.
 *
 * Dropping the globalThis object alone is not a restart: a follow-up
 * regenerate queued on it (scheduleShrinkResume) is a live timer that nothing
 * can reach any more — the test's afterEach resets the NEW state — so it fires
 * into whatever test runs two seconds later, regenerating against that test's
 * mocks. It once finished a provider deletion that test was meant to prove
 * Pinchy finishes on its own.
 */
export function endPinchyProcess(): void {
  _resetConfigPushState();
  globalThis.__pinchyConfigPushState = undefined;
}
