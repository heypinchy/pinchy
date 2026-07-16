import type { JsonlEvent } from "@/lib/diagnostics/jsonl-parser";

/**
 * Exact per-turn token usage extracted from one OpenClaw `model.completed`
 * trajectory event. This is the LOSSLESS replacement for the gauge-sampling
 * usage poller (#483): OpenClaw overwrites its per-session counters every turn,
 * so sampling them misses turns — but every completed turn writes a
 * `model.completed` event whose `data.usage` carries that turn's exact token
 * classes. One event = one turn, uniquely identified by `runId`.
 *
 * Shape verified against live OpenClaw 2026.6.5: `data.usage` is
 * `{input, output, total}` for non-caching providers and
 * `{input, output, cacheRead, cacheWrite, total}` for caching providers
 * (anthropic) — cache fields are simply absent (→ 0) when the provider
 * doesn't cache. Subagent turns carry their own `runId` and are real spend.
 */
export interface PerTurnUsage {
  runId: string;
  seq: number;
  sessionId: string;
  sessionKey: string;
  /** Fully-qualified `<provider>/<modelId>`, or null if either is missing. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Size of the prompt the model actually saw on this turn's LAST call —
   * i.e. how full its context window got. Deliberately NOT `inputTokens`:
   * one turn drives a whole tool loop (~11 LLM calls in the production
   * samples), and `data.usage` sums all of them, so it over-reports the
   * context by roughly that factor. `data.promptCache.lastCallUsage` carries
   * the final call on its own.
   *
   * Counts every prompt class of that call — `input + cacheRead + cacheWrite`
   * — because all three are tokens the model read; they only differ in billing.
   *
   * `null` when the event carries no usable `promptCache.lastCallUsage` —
   * "unknown", which must not be conflated with 0 ("empty context", i.e. 0%
   * utilization).
   */
  contextTokens: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function qualifiedModel(provider: unknown, modelId: unknown): string | null {
  const p = asString(provider);
  const m = asString(modelId);
  return p && m ? `${p}/${m}` : (m ?? null);
}

/**
 * Size of the prompt on the turn's last call, from `data.promptCache
 * .lastCallUsage` — the sum of its three PROMPT classes.
 *
 * `input`, `cacheRead` and `cacheWrite` are disjoint, which the usage payload
 * proves arithmetically: a live event reporting 5 / 630 / 32336 / 16956 carries
 * `total: 49927` — the plain sum, no class counted twice. So the prompt the
 * model read is `input + cacheRead + cacheWrite`; only `output` is not part of
 * it. Cached tokens are still tokens the model sees, they are merely billed at
 * a different rate (see estimateTurnCostUsd), and that holds for the freshly
 * written ones too: on the turn where the context GROWS, the new tail arrives
 * as `cacheWrite`. Dropping either cache class would under-report utilization
 * on exactly the caching providers that run the longest contexts.
 *
 * Returns null when the block is missing, or when it carries none of the three
 * classes, so callers can tell "unknown" apart from "empty" — a 0 here would
 * read as 0% utilization, which is undetectable downstream.
 */
function contextTokensOf(data: Record<string, unknown> | undefined): number | null {
  const lastCall = asRecord(asRecord(data?.promptCache)?.lastCallUsage);
  if (!lastCall) return null;
  const promptTokens =
    asTokenCount(lastCall.input) +
    asTokenCount(lastCall.cacheRead) +
    asTokenCount(lastCall.cacheWrite);
  return promptTokens > 0 ? promptTokens : null;
}

/**
 * Map a session's trajectory events to one exact usage row per completed turn.
 * Events without a `runId` (cannot be deduped) or without a `data.usage`
 * object (not a real completion) are skipped.
 */
export function extractPerTurnUsage(events: JsonlEvent[]): PerTurnUsage[] {
  const rows: PerTurnUsage[] = [];
  for (const event of events) {
    if (event.type !== "model.completed") continue;

    const runId = asString(event.runId);
    if (!runId) continue;

    const data = asRecord(event.data);
    const usage = asRecord(data?.usage);
    if (!usage) continue;

    rows.push({
      runId,
      seq: typeof event.seq === "number" ? event.seq : 0,
      sessionId: asString(event.sessionId) ?? "",
      sessionKey: asString(event.sessionKey) ?? "",
      model: qualifiedModel(event.provider, event.modelId),
      inputTokens: asTokenCount(usage.input),
      outputTokens: asTokenCount(usage.output),
      cacheReadTokens: asTokenCount(usage.cacheRead),
      cacheWriteTokens: asTokenCount(usage.cacheWrite),
      contextTokens: contextTokensOf(data),
    });
  }
  return rows;
}
