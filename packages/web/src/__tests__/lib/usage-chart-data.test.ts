import { describe, it, expect } from "vitest";
import { buildChartData } from "@/lib/usage-chart-data";

describe("buildChartData", () => {
  it("maps timeseries strings to numbers and sums cache read+write into cachedTokens", () => {
    const rows = [
      {
        date: "2026-06-09",
        inputTokens: "7",
        outputTokens: "1474",
        cacheReadTokens: "240171",
        cacheWriteTokens: "163614",
      },
    ];
    expect(buildChartData(rows)).toEqual([
      {
        date: "2026-06-09",
        inputTokens: 7,
        outputTokens: 1474,
        cachedTokens: 403785,
      },
    ]);
  });

  it("treats null/missing cache fields as zero (rows from before the cache fix)", () => {
    const rows = [
      {
        date: "2026-05-14",
        inputTokens: "4000000",
        outputTokens: "50000",
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ];
    expect(buildChartData(rows)).toEqual([
      { date: "2026-05-14", inputTokens: 4000000, outputTokens: 50000, cachedTokens: 0 },
    ]);
  });

  it("returns an empty array for undefined input", () => {
    expect(buildChartData(undefined)).toEqual([]);
  });
});
