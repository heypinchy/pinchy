/**
 * Time-to-completion for a knowledge-base index run (#907).
 *
 * Runtime-free and pure, so the client component can import it and so the rate
 * arithmetic is testable without rendering anything.
 *
 * The unit is BYTES of the corpus, not documents and not chunks. Documents were
 * rejected first: per-document embedding cost varies by orders of magnitude (in
 * the 2026-07 dry-run one compilation PDF was 38% of all chunks, beside hundreds
 * of one-chunk product sheets), so a doc-count projection cheerfully promises
 * "2 min left" at 190/193 and then spends an hour.
 *
 * Chunks are the true unit of embedding work, but their total is unknowable
 * until the corpus has been split — and the obvious way to fill that gap,
 * extrapolating `processedChunks / processed × total`, is algebraically the
 * doc-count projection again (the chunk terms cancel, leaving `processed /
 * total`). Worse, it whipsaws: the moment a 1278-chunk document lands after ten
 * 1-chunk ones, the projected total jumps 100-fold and the bar snaps backwards.
 *
 * Bytes on disk are known EXACTLY at discovery, before the first extract, and
 * they track text volume closely enough that the outsized document is
 * anticipated rather than discovered at 98%. Chunk-level progress still does the
 * work it is uniquely good at — inside a long document, where byte credit is
 * awarded per embedded chunk so the bar keeps moving (see ingest.ts).
 */

export interface ProgressSample {
  /** Wall-clock ms at which the reading was taken. */
  at: number;
  /** Bytes of the corpus behind the run at that moment. */
  processedBytes: number;
}

/**
 * How far back the rate is measured. A window, not the run's average: the
 * average keeps paying for the model load and the discovery walk forever, and
 * never notices that throughput has changed. A minute is long enough to cover
 * the gap between two chunk batches of a slow document, short enough to follow
 * a real change in throughput.
 */
export const ETA_WINDOW_MS = 60_000;

/**
 * The least evidence an estimate may rest on. Two readings a poll apart divide
 * a small delta by a small span and produce noise wearing a number's clothes;
 * below this the honest answer is no answer.
 */
export const ETA_MIN_SPAN_MS = 15_000;

/**
 * Adds a reading and drops the ones that have aged out of the window.
 *
 * Always keeps a predecessor, however old: a one-sample series has no rate at
 * all, so trimming purely by age would erase the estimate exactly when a stalled
 * run makes it most interesting.
 */
export function appendProgressSample(
  samples: readonly ProgressSample[],
  sample: ProgressSample
): ProgressSample[] {
  const kept = samples.filter((s) => s.at >= sample.at - ETA_WINDOW_MS);
  const predecessor = kept.length > 0 ? kept : samples.slice(-1);
  return [...predecessor, sample];
}

/**
 * Milliseconds of work left, or null when the samples cannot support an answer.
 *
 * Null is a first-class result, not a failure: an ETA that lies is worse than no
 * ETA, and "not enough evidence yet" is the state a run spends its first seconds
 * in.
 */
export function estimateRemainingMs(
  samples: readonly ProgressSample[],
  totalBytes: number | null
): number | null {
  if (totalBytes === null || totalBytes <= 0) return null;
  if (samples.length < 2) return null;

  const last = samples[samples.length - 1];
  // Trim to the window, but never below the two readings a rate needs — the
  // series may legitimately consist of one ancient sample and one fresh one.
  const withinWindow = samples.findIndex((s) => s.at >= last.at - ETA_WINDOW_MS);
  const startIdx =
    withinWindow < 0 || withinWindow > samples.length - 2 ? samples.length - 2 : withinWindow;
  const first = samples[startIdx];

  const spanMs = last.at - first.at;
  if (spanMs < ETA_MIN_SPAN_MS) return null;

  const doneBytes = last.processedBytes - first.processedBytes;
  if (doneBytes <= 0) return null;

  // Clamped at zero: `processedBytes` can overshoot a `totalBytes` snapshotted a
  // poll earlier, and a negative remaining is not a shorter wait.
  const remainingBytes = Math.max(0, totalBytes - last.processedBytes);
  return (remainingBytes * spanMs) / doneBytes;
}

/**
 * Humanizes a remaining duration as "~12 min left" / "~2 h 5 min left".
 *
 * The tilde is load-bearing: this is a projection off a rolling rate, and the
 * one thing it must not do is read like a countdown. Under a minute it names no
 * number at all — second precision on an estimate is a claim the estimate cannot
 * back.
 */
export function formatEta(remainingMs: number): string {
  if (!(remainingMs >= 60_000)) return "under a minute left";

  const totalMin = Math.round(remainingMs / 60_000);
  if (totalMin < 60) return `~${totalMin} min left`;

  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes === 0 ? `~${hours} h left` : `~${hours} h ${minutes} min left`;
}
