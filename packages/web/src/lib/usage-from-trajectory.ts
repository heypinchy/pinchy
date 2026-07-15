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
   * `null` when the event has no `promptCache` block — "unknown", which must
   * not be conflated with 0 ("empty context", i.e. 0% utilization).
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
 * .lastCallUsage`. The cached prefix counts: it is still part of the prompt the
 * model sees, only billed differently — excluding it would under-report
 * utilization on exactly the caching providers that run the longest contexts.
 * Returns null when the block is absent, so callers can tell "unknown" apart
 * from "empty".
 */
function contextTokensOf(data: Record<string, unknown> | undefined): number | null {
  const lastCall = asRecord(asRecord(data?.promptCache)?.lastCallUsage);
  if (!lastCall) return null;
  return asTokenCount(lastCall.input) + asTokenCount(lastCall.cacheRead);
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
