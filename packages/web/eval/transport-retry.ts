/**
 * Retries an eval step across a lost uplink, and nothing else.
 *
 * This laptop travels; an offline stretch is an operating condition, not an
 * incident. The KB sweep's existing `withRetry` guards per-model setup only,
 * so the run itself — dispatch, audit read, and the Ollama Cloud judge call —
 * had no retry at all. One dead zone cost 15 of 48 runs and left two model
 * cells unreadable: a run that never happened and a run that scored zero
 * looked the same afterwards.
 *
 * Two decisions are load-bearing:
 *
 *   - **Transport faults only.** `isTransportError` errs towards "this is the
 *     result": retrying a real defect makes it look intermittent and files it
 *     under a note blaming the network.
 *   - **Growing delays.** A fixed 8s×4 rides out a hiccup and nothing longer,
 *     and the gap between a hiccup and a tunnel is exactly where the sweep
 *     kept dying. The schedule below spends about nine minutes before giving
 *     up — cheap against a 27-minute sweep, and it still gives up.
 */

import { describeError, isTransportError } from "./error-detail";

/** Backoff between attempts. Total ≈ 9 min, so a tunnel is survivable. */
const RETRY_DELAYS_MS = [10_000, 45_000, 150_000, 330_000];

export interface TransportRetryOptions {
  /** What is being attempted, for the operator-facing line. */
  what: string;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable sink; defaults to console.warn. */
  log?: (line: string) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` until it succeeds, it fails for a reason that is not the network,
 * or the backoff schedule is exhausted. `fn` receives the 1-based attempt
 * number: the KB sweep uses it to mint a fresh chatId, because resuming a
 * half-dispatched chat would grade a conversation the model already started
 * answering before the connection dropped.
 */
export async function withTransportRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: TransportRetryOptions
): Promise<T> {
  const { what } = options;
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? ((line: string) => console.warn(line));

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      // Out of budget, or not our kind of failure: hand it back so the caller
      // records an invalid trial rather than a model result.
      if (delay === undefined || !isTransportError(err)) throw err;

      log(
        `[eval] ${what} attempt ${String(attempt)} hit a transport fault, ` +
          `retrying in ${String(Math.round(delay / 1000))}s: ${describeError(err)}`
      );
      await sleep(delay);
    }
  }
}
