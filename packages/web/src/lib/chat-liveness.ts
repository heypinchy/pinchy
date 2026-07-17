/**
 * Chat-liveness thresholds shared by the client runtime and the test doubles
 * that have to out-wait it.
 *
 * This lives outside `use-ws-runtime.ts` purely so non-React callers can read
 * it: the hook is a `"use client"` module that pulls in React, sonner and the
 * component tree, which a `@vitest-environment node` test cannot import.
 */

/**
 * How long a run may be in flight before the UI shows "taking longer than
 * expected".
 *
 * The fake-ollama SLOW trigger's stall (`LIVENESS_SLOW_DELAY_MS`) must sit PAST
 * this threshold — that stall is the only reason the banner engages in the E2E
 * spec that proves it does. Raise this above the stall and the spec stops
 * exercising the banner while staying green, which is the failure
 * `fake-ollama-liveness.test.ts` now pins.
 */
export const DELAY_HINT_MS = 15_000;
