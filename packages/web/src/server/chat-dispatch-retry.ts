// packages/web/src/server/chat-dispatch-retry.ts
//
// Defensive workaround for an OpenClaw 2026.5.x race between `config.get`
// and the `agent` RPC dispatch handler: after a `config.apply` that adds an
// agent to `agents.list`, `config.get` immediately reports the agent as
// present (i.e. `agentDispatchable=true` via our health endpoint), but the
// `agent` RPC handler can still reject the same agent id with
// `errorCode=INVALID_REQUEST errorMessage="invalid agent params: unknown
// agent id <uuid>"`.
//
// Observed on PR #442 CI runs 26505503327, 26511658136 and others — the
// failing chat dispatch happens 1–2 s after `waitForAgentDispatchable`
// returned true, and the `agent` RPC fails in ~25 ms (OC's internal
// rejection, not an upstream provider error). E2E tests added an
// `waitForAgentDispatchable` gate before each dispatch (close PR #442
// commit ec9eb0027), but it polls `config.get` which is exactly the path
// that disagrees with the dispatch handler, so the gate doesn't fully
// close the race.
//
// Industry practice for stream-truncation / transient-handler errors is
// single auto-retry with a short delay (see issue #355 § "industry
// best-practices summary"): OpenAI/Anthropic/Vercel SDKs all retry on
// 5xx and stream-protocol errors. "unknown agent id" sits in the
// 400-class normally — for a genuine bad id we do NOT want to retry,
// because that masks real bugs. The race here is specifically the
// 5xx-shaped variant where Pinchy KNOWS the agent exists (it just
// created it and confirmed via `config.get`), so the single retry is
// safe within this narrow window.
//
// Implementation: async-generator wrapper around `openclawClient.chat`.
// On the FIRST yielded chunk:
//   - If it's an `error` chunk matching the "unknown agent id" pattern
//     AND we haven't retried yet, swallow it, wait `retryDelayMs`, then
//     restart the chat stream.
//   - Otherwise, yield it through and pipe the rest of the stream
//     unchanged. Errors arriving AFTER the first chunk are pass-through
//     too — they're not the dispatch race, they're real downstream
//     failures the caller's existing error path must surface.
//
// The retry is bounded to ONE attempt and only fires for this specific
// error string, so it can't mask other failure shapes or run away.

import type { ChatChunk, ChatOptions } from "openclaw-node";

/**
 * Pattern matching OpenClaw 2026.5.x's dispatch-race error. Anchored on
 * `unknown agent id` (the OC-internal phrase) rather than a generic
 * substring so a future provider error mentioning the words "agent" and
 * "unknown" in unrelated context cannot hijack the retry branch.
 *
 * Matches the literal `unknown agent id "<uuid>"` shape; case-insensitive
 * to defend against an upstream message-casing tweak.
 */
export const DISPATCH_RACE_PATTERN = /unknown agent id/i;

/**
 * Default delay before retrying. Picked at 500 ms because:
 *   - OC's failing `agent` RPC returns in ~25 ms (it's a synchronous
 *     internal-state check, not a network round-trip), so a tight retry
 *     wouldn't see new state.
 *   - The race window observed in CI is 1–2 s wide between
 *     `waitForAgentDispatchable` returning true and dispatch rejection.
 *     500 ms covers most cases; if the dispatch handler is still stale
 *     after another 500 ms, the second attempt's error gets surfaced
 *     (the test will fail loudly rather than retrying forever).
 *   - Industry guides (#355) recommend 1 s as the first retry delay
 *     with exponential backoff; 500 ms is the lower end of that range
 *     and acceptable for a single-shot retry without backoff.
 */
export const DEFAULT_DISPATCH_RETRY_DELAY_MS = 500;

export interface DispatchRetryDeps {
  chat: (message: string, options?: ChatOptions) => AsyncGenerator<ChatChunk>;
  /**
   * Sleep helper, injectable so tests don't have to wait real time.
   */
  delay?: (ms: number) => Promise<void>;
  /**
   * Audit callback invoked when the first attempt failed with the
   * dispatch-race pattern. The audit is the diagnostic signal we use
   * to measure how often this race fires in production; without it the
   * retry would be invisible.
   */
  onDispatchRaceObserved?: (info: { providerError: string; attempt: number }) => void;
}

/**
 * Wraps `openclawClient.chat()` with single-shot retry on the
 * `unknown agent id` dispatch-race error.
 *
 * Contract:
 *   - Yields ALL chunks from the FIRST successful attempt (where
 *     "successful" means the first chunk is NOT an unknown-agent-id error).
 *   - On the first chunk being an unknown-agent-id error, swallows it,
 *     waits `retryDelayMs`, and restarts the chat. Yields all chunks
 *     from the retry attempt verbatim, including any errors.
 *   - Only retries ONCE; a second dispatch-race error is forwarded as
 *     a real failure (the assumption is that if 500 ms didn't settle
 *     OC's internal state, something is genuinely wrong).
 *   - Never retries on errors arriving AFTER the first chunk — those
 *     are real downstream failures (provider 5xx, schema rejection,
 *     etc.) that the caller's existing error path must handle.
 */
export async function* chatWithDispatchRaceRetry(
  message: string,
  options: ChatOptions | undefined,
  deps: DispatchRetryDeps,
  retryDelayMs: number = DEFAULT_DISPATCH_RETRY_DELAY_MS
): AsyncGenerator<ChatChunk> {
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; attempt <= 1; attempt++) {
    const stream = deps.chat(message, options);
    let isFirstChunk = true;
    let didRetry = false;

    for await (const chunk of stream) {
      if (
        isFirstChunk &&
        attempt === 0 &&
        chunk.type === "error" &&
        DISPATCH_RACE_PATTERN.test(chunk.text)
      ) {
        // Dispatch-race detected. Don't yield this chunk; the audit
        // callback records the observation for measurement and the
        // outer loop retries after the delay.
        if (deps.onDispatchRaceObserved) {
          deps.onDispatchRaceObserved({ providerError: chunk.text, attempt });
        }
        didRetry = true;
        break;
      }
      isFirstChunk = false;
      yield chunk;
    }

    if (!didRetry) {
      // Either the first attempt produced a non-race chunk (yielded
      // through), or the second attempt completed (success or not).
      // Either way, we're done.
      return;
    }
    await delay(retryDelayMs);
  }
}
