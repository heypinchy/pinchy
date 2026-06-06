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
// `config.get`-based readiness gates CANNOT close this race: `config.get` reads
// the FILE, which leads the applied runtime, so a file-based gate reports
// "ready" while the dispatch handler still rejects. The reliable signal is OC's
// `agents.list` RPC (openclaw-node >= 0.12.0): verified against OC 2026.5.28,
// it reads the SAME `getRuntimeConfig()` view the dispatch handler checks, so
// once an id appears there a dispatch will not be rejected. We therefore prefer
// a DETERMINISTIC GATE — poll `agents.list` until the agent is present (the
// injected `awaitAgentReady` dep, backed by `agent-readiness.ts`) — and only
// fall back to blind exponential backoff when the gate is absent or
// unobservable (older Gateway). Either way the loop stays bounded by the
// wall-clock budget and re-dispatches the real chat once readiness lands.
//
// Historical note: before the gate existed this loop relied purely on blind
// backoff-retry of the real dispatch (the "only a successful dispatch is a
// reliable signal" era — true while `config.get` was the only introspection
// openclaw-node wrapped). The gate makes the common case deterministic instead
// of probabilistic; the backoff retry remains the backstop.
//
// Safety: this ONLY retries the literal `unknown agent id` shape, and ONLY
// when it is the FIRST chunk. For an agent Pinchy just created and confirmed,
// that error is ALWAYS the transient apply-lag — a genuinely bad id would be a
// Pinchy bug (Pinchy owns the id), and after the budget we surface the error
// rather than loop forever. Errors after the first chunk, and any other error
// shape, pass straight through to the caller's existing error path. So the
// loop cannot mask provider failures, schema rejections, or stream truncation.
//
// No orphaned OC runs: a retried attempt failed because OC REJECTED the
// dispatch ("unknown agent id", ~25 ms, before any run is created), so there is
// no server-side run to leak. Breaking the `for await` on the rejection also
// returns the underlying chat generator, releasing its request.

import type { ChatChunk, ChatOptions } from "openclaw-node";

/**
 * Pattern matching OpenClaw 2026.5.x's dispatch-race error. Anchored on
 * `unknown agent id` (the OC-internal phrase) rather than a generic substring
 * so a future provider error mentioning the words "agent" and "unknown" in
 * unrelated context cannot hijack the retry branch. Case-insensitive to defend
 * against an upstream message-casing tweak.
 */
export const DISPATCH_RACE_PATTERN = /unknown agent id/i;

/**
 * Second cold-start race shape: the config-apply storm can land an agent
 * (`agents.list`) into OC's runtime BEFORE its model's provider (`models`).
 * OC then ACCEPTS the dispatch (the agent id is known) but the run immediately
 * errors `FailoverError: Unknown model: <provider>/<model>` because the
 * provider block hasn't applied yet. Observed on the OC 2026.6.1 setup-wizard
 * Google spec: agent applied at 07:18:04, `models` at 07:19:06, first chat
 * dispatched at 07:18:26 → "Unknown model" (the provider landed ~40 s later).
 *
 * Anchored on `unknown model` (OC's internal phrase) so an unrelated provider
 * error that merely contains the word "model" (e.g. "provider/model ended with
 * an incomplete terminal response") cannot hijack the retry branch.
 * Case-insensitive against an upstream message-casing tweak.
 *
 * Safety / why a bounded retry is correct here, mirroring the agent-id case:
 * Pinchy OWNS the agent's model selection — the setup wizard picks a known
 * provider default and `/settings` validates against the provider catalog — so
 * "Unknown model" for a Pinchy-managed agent is the transient apply-lag, not a
 * real misconfiguration. The `maxTotalMs` budget still bounds the loop, so even
 * a genuinely-unknown model surfaces (never hangs forever). Unlike the agent
 * race there is NO deterministic gate: `agents.list` only reports agent
 * presence (already true here), and openclaw-node 0.12.1 exposes no runtime
 * `models` view, so the model race relies on the bounded-backoff backstop.
 */
export const MODEL_DISPATCH_RACE_PATTERN = /unknown model/i;

/**
 * Chunk types that represent real model output the user would see (or that a
 * retry would duplicate). Once one of these is yielded, the run is genuinely
 * producing a response, so a later error is a downstream failure — never a
 * cold-start dispatch race — and must NOT be retried. Everything else that can
 * precede the model error (the `userMessagePersisted` accepted-dispatch ack,
 * lifecycle frames) is replay-safe / idempotent on the client.
 */
const OUTPUT_CHUNK_TYPES: ReadonlySet<string> = new Set(["text", "tool_use", "tool_result"]);

/** Backoff/budget policy for the dispatch-race retry loop. */
export interface DispatchRetryPolicy {
  /** Delay before the first retry; doubles each attempt. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay (caps the exponential). Default 5 s. */
  maxDelayMs?: number;
  /**
   * Total wall-clock budget for retrying. Once exceeded, the last race error is
   * yielded so the caller surfaces it. Default 150 s — the original 90 s was
   * actually SHORTER than this file's own documented worst case (the #448
   * fresh-install gap was 114 s; the Odoo/email/web dispatch-probe E2E measured
   * an OpenClaw agents-reload landing ~104 s after the first dispatch when
   * rapid config writes coalesce in OC's file-watcher debounce, so the agent
   * applied 14 s AFTER the 90 s budget gave up — the residual dispatch-probe
   * flake). 150 s covers both with margin while staying bounded so a
   * genuinely-unknown agent (a Pinchy-side bug) can't hang the chat forever.
   */
  maxTotalMs?: number;
}

const DEFAULT_POLICY: Required<DispatchRetryPolicy> = {
  baseDelayMs: 500,
  maxDelayMs: 5000,
  maxTotalMs: 150000,
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
  /**
   * Optional runtime-readiness gate. When provided, on a dispatch-race error the
   * wrapper awaits this — bounded by the REMAINING budget — INSTEAD of a blind
   * backoff sleep, then re-dispatches. It should resolve:
   *   - `true`  → the target agent is now present in OpenClaw's RUNTIME
   *               `agents.list` (the same view the dispatch handler checks), so
   *               the next dispatch will land; retry immediately, no sleep.
   *   - `false` → readiness could not be confirmed within the window (timeout,
   *               or unobservable on an older Gateway without `agents.list`); the
   *               wrapper falls back to its capped blind backoff so the bounded
   *               retry is preserved.
   *
   * This turns the blind "sleep and hope" retry into a deterministic gate.
   * Absent → pure exponential backoff (the original behaviour), which remains
   * the backstop. See `agent-readiness.ts` for why `agents.list` is reliable
   * where `config.get` is not.
   */
  awaitAgentReady?: (budgetMs: number) => Promise<boolean>;
}

/**
 * Wraps `openclawClient.chat()` with a bounded exponential-backoff retry on the
 * `unknown agent id` dispatch-race error.
 *
 * Contract:
 *   - Yields ALL chunks from an attempt that produces real model output (or any
 *     non-race error).
 *   - While a race error arrives BEFORE any model-output chunk (text / tool
 *     use / tool result), swallows it, waits/gates, and restarts the chat —
 *     repeating until success or the `maxTotalMs` budget is exhausted.
 *   - On budget exhaustion, yields the final race error so the caller surfaces
 *     it (never loops forever).
 *   - Never retries on errors arriving AFTER model output has started, or on any
 *     error not matching a dispatch-race pattern — those are real downstream
 *     failures the caller's error path must handle.
 *
 * Why "before model output" and not "first chunk": a client-originated message
 * carries a `clientMessageId`, so OpenClaw ACKs an accepted dispatch with a
 * leading `userMessagePersisted` chunk. In the provider/models apply-lag race
 * the dispatch is ACCEPTED (ack emitted) and only THEN fails resolving the model
 * → the race error is the SECOND chunk, after the ack. Gating on model output
 * (not chunk position) catches that while still refusing to retry once real
 * tokens have streamed. The leading ack is yielded immediately (not buffered) so
 * the browser's ack-timeout clears and the user's message isn't marked failed;
 * a retry re-emits it, which is idempotent on the client (ack dedupes by id).
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
    // Real model output yielded yet this attempt? Leading ack/lifecycle chunks
    // (e.g. `userMessagePersisted`) are NOT output: the model race fails AFTER
    // the accepted-dispatch ack, so we must still treat that error as a race.
    // Once real output streams, a later error is a genuine downstream failure.
    let sawOutput = false;
    let raceError: ChatChunk | null = null;
    // Which cold-start race fired: "agent" has a deterministic agents.list gate;
    // "model" (provider/models not applied yet) does not, so it backoff-only.
    let raceKind: "agent" | "model" | null = null;

    for await (const chunk of stream) {
      if (!sawOutput && chunk.type === "error") {
        // Race detected before any model output. Don't yield it; record the
        // observation and let the loop decide whether to retry or give up.
        if (DISPATCH_RACE_PATTERN.test(chunk.text)) {
          raceError = chunk;
          raceKind = "agent";
          break;
        }
        if (MODEL_DISPATCH_RACE_PATTERN.test(chunk.text)) {
          raceError = chunk;
          raceKind = "model";
          break;
        }
      }
      if (OUTPUT_CHUNK_TYPES.has(chunk.type)) sawOutput = true;
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

    // Deterministic readiness gate (preferred) — AGENT race only: poll OC's
    // runtime agents.list (the same view the dispatch handler checks) until the
    // agent is present, bounded by the remaining budget. On success, re-dispatch
    // immediately into a ready runtime instead of sleeping a backoff window.
    //
    // The MODEL race deliberately skips this gate: the agent is ALREADY present
    // (OC accepted the dispatch before failing on the model), so the gate would
    // return true and immediate-continue into a hot loop while the provider is
    // still unapplied. With no runtime-`models` introspection to gate on, the
    // model race relies on the capped backoff below.
    if (raceKind === "agent" && deps.awaitAgentReady) {
      const ready = await deps.awaitAgentReady(remaining);
      if (ready) continue;
      // Not confirmed within the window (timeout, or unobservable on an older
      // Gateway). Fall through to the capped backoff so we keep making bounded
      // progress rather than hot-looping on a still-unready runtime.
    }

    // Exponential backoff capped at maxDelayMs, and never sleeping past the
    // remaining budget. Recompute the budget: a readiness gate above may have
    // consumed part of it.
    const remainingAfterGate = maxTotalMs - (now() - start);
    if (remainingAfterGate <= 0) {
      yield raceError;
      return;
    }
    const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await delay(Math.min(backoff, remainingAfterGate));
  }
}
