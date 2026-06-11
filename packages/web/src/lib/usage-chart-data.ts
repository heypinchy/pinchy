/**
 * Maps the /api/usage/timeseries rows (numeric strings from SQL sum()) into
 * the numeric points the Daily Token Usage chart renders.
 *
 * `cachedTokens` combines cache reads and writes into one series: both are
 * input-class traffic the provider actually processed. With prompt caching
 * (Anthropic et al.) the uncached `inputTokens` can be single digits per turn
 * while the cache moves hundreds of thousands — without this series the chart
 * suggested a near-idle day for heavy usage ("Input: 7" staging finding).
 */
export interface UsageTimeseriesRow {
  date: string;
  inputTokens: string | null;
  outputTokens: string | null;
  cacheReadTokens?: string | null;
  cacheWriteTokens?: string | null;
}

export interface UsageChartPoint {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export function buildChartData(rows: UsageTimeseriesRow[] | undefined): UsageChartPoint[] {
  return (rows ?? []).map((p) => ({
    date: p.date,
    inputTokens: Number(p.inputTokens ?? 0),
    outputTokens: Number(p.outputTokens ?? 0),
    cachedTokens: Number(p.cacheReadTokens ?? 0) + Number(p.cacheWriteTokens ?? 0),
  }));
}
