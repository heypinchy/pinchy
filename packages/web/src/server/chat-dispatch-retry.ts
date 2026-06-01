// packages/web/src/server/chat-dispatch-retry.ts
//
// Defensive wrapper for the window after a fresh-install setup (or any
// config-reload / gateway restart) where Pinchy has created an agent and
// confirmed it via `config.get`, but OpenClaw's `agent` RPC dispatch handler
// still rejects the id with `errorCode=INVALID_REQUEST errorMessage="invalid
// agent params: unknown agent id <uuid>"`.
//
// Why a BOUNDED RETRY LOOP rather than a single shot:
//
// `config.get` reads the config FILE; the dispatch handler checks the APPLIED
// runtime `agents.list`. The two diverge until OC finishes applying the
// reload. Normally that lag is 1–2 s. But on a fresh install the lag balloons:
// the cold-start regeneration storm (firstConnect seed + provider save +
// agent-model update) plus OC 5.3's `config.apply` rate-limit (~3 calls per
// 45 s) plus the secrets-bootstrap gateway pkill (config/start-openclaw.sh,
// ~40 s respawn) push the real `agents.list` apply out by up to ~90–120 s.
// Observed directly on PR #448 CI: the first chat dispatched at 13:22:04 hit
// "unknown agent id" and the agent only became dispatchable at 13:23:58 —
// a 114 s gap that a single 500 ms retry could never bridge, surfacing
// "Smithers couldn't respond" on a brand-new user's first message.
//
// `config.get`-based readiness gates (waitForAgentInRuntime, the
// `agentDispatchable` health probe) CANNOT close this race: they poll the same
// file-vs-runtime-divergent path. The only reliable readiness signal is a
// dispatch that actually succeeds — so we retry the real dispatch with
// exponential backoff until it lands or a wall-clock budget elapses.
//
// Safety: this ONLY retries the literal `unknown agent id` shape, and ONLY
// when it is the FIRST chunk. For an agent Pinchy just created and confirmed,
// that error is ALWAYS the transient apply-lag — a genuinely bad id would be a
// Pinchy bug (Pinchy owns the id), and after the budget we surface the error
// rather than loop forever. Errors after the first chunk, and any other error
// shape, pass straight through to the caller's existing error path. So the
// loop cannot mask provider failures, schema rejections, or stream truncation.

import type { ChatChunk, ChatOptions } from "openclaw-node";

/**
 * Pattern matching OpenClaw 2026.5.x's dispatch-race error. Anchored on
 * `unknown agent id` (the OC-internal phrase) rather than a generic substring
 * so a future provider error mentioning the words "agent" and "unknown" in
 * unrelated context cannot hijack the retry branch. Case-insensitive to defend
 * against an upstream message-casing tweak.
 */
export const DISPATCH_RACE_PATTERN = /unknown agent id/i;

/** Backoff/budget policy for the dispatch-race retry loop. */
export interface DispatchRetryPolicy {
  /** Delay before the first retry; doubles each attempt. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay (caps the exponential). Default 5 s. */
  maxDelayMs?: number;
  /**
   * Total wall-clock budget for retrying. Once exceeded, the last race error is
   * yielded so the caller surfaces it. Default 90 s — comfortably covers one
   * gateway restart + a `config.apply` rate-limit window; bounded so a
   * genuinely-unknown agent can't hang the chat forever.
   */
  maxTotalMs?: number;
}

const DEFAULT_POLICY: Required<DispatchRetryPolicy> = {
  baseDelayMs: 500,
  maxDelayMs: 5000,
  maxTotalMs: 90000,
};

export interface DispatchRetryDeps {
  chat: (message: string, options?: ChatOptions) => AsyncGenerator<ChatChunk>;
  /** Sleep helper, injectable so tests don't wait real time. */
  delay?: (ms: number) => Promise<void>;
  /** Clock, injectable so tests drive the wall-clock budget deterministically. */
  now?: () => number;
  /**
   * Invoked once per observed dispatch-race failure (each retry). The audit
   * this drives is how we measure the race in production; without it the retry
   * loop would be invisible.
   */
  onDispatchRaceObserved?: (info: { providerError: string; attempt: number }) => void;
}

/**
 * Wraps `openclawClient.chat()` with a bounded exponential-backoff retry on the
 * `unknown agent id` dispatch-race error.
 *
 * Contract:
 *   - Yields ALL chunks from the first attempt whose first chunk is NOT an
 *     unknown-agent-id error.
 *   - While the first chunk IS an unknown-agent-id error, swallows it, waits a
 *     backoff delay (exponential, capped at `maxDelayMs`), and restarts the
 *     chat — repeating until success or the `maxTotalMs` budget is exhausted.
 *   - On budget exhaustion, yields the final race error so the caller surfaces
 *     it (never loops forever).
 *   - Never retries on errors arriving AFTER the first chunk, or on any error
 *     not matching the dispatch-race pattern — those are real downstream
 *     failures the caller's error path must handle.
 */
export async function* chatWithDispatchRaceRetry(
  message: string,
  options: ChatOptions | undefined,
  deps: DispatchRetryDeps,
  policy: DispatchRetryPolicy = {}
): AsyncGenerator<ChatChunk> {
  const { baseDelayMs, maxDelayMs, maxTotalMs } = { ...DEFAULT_POLICY, ...policy };
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const start = now();
  for (let attempt = 0; ; attempt++) {
    const stream = deps.chat(message, options);
    let isFirstChunk = true;
    let raceError: ChatChunk | null = null;

    for await (const chunk of stream) {
      if (isFirstChunk && chunk.type === "error" && DISPATCH_RACE_PATTERN.test(chunk.text)) {
        // Dispatch-race detected on the first chunk. Don't yield it; record the
        // observation and let the loop decide whether to retry or give up.
        raceError = chunk;
        break;
      }
      isFirstChunk = false;
      yield chunk;
    }

    if (!raceError) {
      // First attempt produced a non-race chunk (yielded through), or a retry
      // attempt completed. Either way we're done.
      return;
    }

    // Audit ONCE per raced dispatch (on the first observation), not once per
    // retry — a long storm can take ~15 attempts and we don't want 15 audit
    // rows skewing the per-class dashboards (#355).
    if (attempt === 0) {
      deps.onDispatchRaceObserved?.({ providerError: raceError.text, attempt });
    }

    const elapsed = now() - start;
    const remaining = maxTotalMs - elapsed;
    if (remaining <= 0) {
      // Budget exhausted — surface the error rather than retry forever.
      yield raceError;
      return;
    }

    // Exponential backoff capped at maxDelayMs, and never sleeping past the
    // remaining budget.
    const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await delay(Math.min(backoff, remaining));
  }
}
