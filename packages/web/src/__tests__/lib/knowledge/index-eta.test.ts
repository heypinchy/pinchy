import { describe, it, expect } from "vitest";

import {
  ETA_MIN_SPAN_MS,
  ETA_WINDOW_MS,
  appendProgressSample,
  estimateRemainingMs,
  formatEta,
  type ProgressSample,
} from "@/lib/knowledge/index-eta";

const T0 = Date.parse("2026-07-21T10:00:00.000Z");

/** Builds a sample series from `[secondsAfterT0, processedBytes]` pairs. */
function samples(...pairs: Array<[number, number]>): ProgressSample[] {
  return pairs.map(([sec, processedBytes]) => ({ at: T0 + sec * 1000, processedBytes }));
}

describe("estimateRemainingMs", () => {
  it("projects the remaining work from the observed rate", () => {
    // 100 kB in 20 s = 5 kB/s; 800 kB left = 160 s.
    const remaining = estimateRemainingMs(samples([0, 100_000], [20, 200_000]), 1_000_000);
    expect(remaining).toBe(160_000);
  });

  // The whole reason this is a rate over a WINDOW and not `elapsed / processed`
  // over the run: the run's own average keeps paying for the model load and the
  // discovery walk forever, and never notices that throughput has changed.
  it("measures the recent rate, not the run's average", () => {
    // A fast first minute (500 kB), then a slow stretch (50 kB in 60 s).
    const series = samples([0, 0], [60, 500_000], [90, 525_000], [120, 550_000]);
    const remaining = estimateRemainingMs(series, 1_000_000);
    // Off the last 60 s only: 50 kB / 60 s ≈ 833 B/s, 450 kB left ≈ 540 s.
    expect(remaining).toBe(540_000);
    // The run average (550 kB / 120 s) would have claimed ~98 s — a number the
    // run has not been able to deliver for the last two minutes.
    expect(remaining).toBeGreaterThan(400_000);
  });

  // An estimate off two readings seconds apart is noise wearing a number's
  // clothes. Saying nothing is the honest answer until the window has evidence.
  it("declines to answer until the samples span enough time", () => {
    expect(estimateRemainingMs(samples([0, 100_000], [5, 200_000]), 1_000_000)).toBeNull();
    expect(estimateRemainingMs(samples([0, 100_000]), 1_000_000)).toBeNull();
    expect(estimateRemainingMs([], 1_000_000)).toBeNull();
  });

  it("declines to answer while no measurable progress has been made", () => {
    // A run stuck on one document for the whole window has no rate to divide by
    // — an "∞ min left" is worse than an absent estimate.
    expect(estimateRemainingMs(samples([0, 100_000], [60, 100_000]), 1_000_000)).toBeNull();
  });

  it("declines to answer without a known total", () => {
    expect(estimateRemainingMs(samples([0, 0], [60, 100_000]), 0)).toBeNull();
    expect(estimateRemainingMs(samples([0, 0], [60, 100_000]), null)).toBeNull();
  });

  // `processedBytes` can overshoot a total snapshotted a poll earlier. Zero is
  // the honest floor; a negative remaining would format as "under a minute
  // left" only by accident of the sign surviving the rounding.
  it("floors an overshooting reading at zero rather than going negative", () => {
    expect(estimateRemainingMs(samples([0, 900_000], [60, 1_100_000]), 1_000_000)).toBe(0);
  });
});

describe("appendProgressSample", () => {
  it("keeps the series inside the rolling window", () => {
    const old = samples([0, 0], [10, 10_000], [20, 20_000]);
    const next = appendProgressSample(old, { at: T0 + ETA_WINDOW_MS + 15_000, processedBytes: 90 });
    // Everything older than the window is dropped; what remains still spans it.
    expect(next.every((s) => s.at >= T0 + 15_000)).toBe(true);
    expect(next.at(-1)?.processedBytes).toBe(90);
  });

  // Trimming to the window alone would leave a single sample behind after a
  // long stall — and a one-sample series has no rate at all, so the estimate
  // would vanish exactly when the operator most wants to know it is still slow.
  it("always keeps a predecessor, however old, so a rate stays computable", () => {
    const stale = samples([0, 10_000]);
    const next = appendProgressSample(stale, {
      at: T0 + 10 * ETA_WINDOW_MS,
      processedBytes: 20_000,
    });
    expect(next).toHaveLength(2);
    expect(next[0].processedBytes).toBe(10_000);
  });

  it("carries enough history for the minimum span to be reachable", () => {
    expect(ETA_WINDOW_MS).toBeGreaterThan(ETA_MIN_SPAN_MS);
  });
});

describe("formatEta", () => {
  it("does not pretend to second precision under a minute", () => {
    expect(formatEta(20_000)).toBe("under a minute left");
    expect(formatEta(0)).toBe("under a minute left");
  });

  it("rounds to whole minutes under an hour, marked as an estimate", () => {
    expect(formatEta(3 * 60_000)).toBe("~3 min left");
    expect(formatEta(3 * 60_000 + 40_000)).toBe("~4 min left");
  });

  it("shows hours and minutes past an hour", () => {
    expect(formatEta((2 * 60 + 5) * 60_000)).toBe("~2 h 5 min left");
    expect(formatEta(3 * 3_600_000)).toBe("~3 h left");
  });
});
