/**
 * In-memory throttle for `agent.model_unavailable` audit events.
 *
 * Limitations (intentional for this iteration; tracked as follow-ups in #305):
 *
 *  1. **Per-process state.** The Map is reset on container restart, so a
 *     deploy clears the throttle and the next 5xx will emit fresh. Acceptable
 *     because audit telemetry consumers should expect bursts at process start.
 *
 *  2. **Read-then-write race.** Two concurrent WS streams hitting the same
 *     `(agentId, model)` pair within microseconds can both observe
 *     `last === undefined` and both emit. JavaScript is single-threaded so this
 *     only occurs across `await` boundaries in callers; the worst-case is a
 *     handful of duplicates per restart, not a thundering herd. A DB-backed
 *     throttle (the planned follow-up) will use a unique constraint on
 *     `(agent_id, model, bucket)` to make this race a no-op.
 */
const lastEmittedAt = new Map<string, number>();
const lastSilentStreamAt = new Map<string, number>();
const lastUpstreamFormatErrorAt = new Map<string, number>();
const TTL_MS = 5 * 60 * 1000;

export function shouldEmitModelUnavailableAudit(
  agentId: string,
  model: string,
  now: number = Date.now()
): boolean {
  const key = `${agentId}:${model}`;
  const last = lastEmittedAt.get(key);
  if (last !== undefined && now - last < TTL_MS) return false;
  lastEmittedAt.set(key, now);
  return true;
}

/**
 * Throttle for `chat.silent_stream` audit events (issue #320). Kept separate
 * from the 5xx throttle so two different failure modes for the same
 * `(agentId, model)` pair within the TTL still both audit — they're distinct
 * operational signals (one is a provider-side error event, the other is a
 * silent timeout where no event ever arrives).
 */
export function shouldEmitSilentStreamAudit(
  agentId: string,
  model: string,
  now: number = Date.now()
): boolean {
  const key = `${agentId}:${model}`;
  const last = lastSilentStreamAt.get(key);
  if (last !== undefined && now - last < TTL_MS) return false;
  lastSilentStreamAt.set(key, now);
  return true;
}

/**
 * Throttle for `agent.upstream_format_error` audit events (issue #338).
 * Kept separate from the 5xx and silent-stream throttles so a tool-using turn
 * that hits a 400 schema rejection (e.g. Gemini 3 missing `thought_signature`,
 * openclaw/openclaw#72879) still audits even when the same (agent, model) pair
 * had a 5xx or silent-stream blip within the TTL. The three signals are
 * operationally distinct and feed different remediation decisions.
 */
export function shouldEmitUpstreamFormatErrorAudit(
  agentId: string,
  model: string,
  now: number = Date.now()
): boolean {
  const key = `${agentId}:${model}`;
  const last = lastUpstreamFormatErrorAt.get(key);
  if (last !== undefined && now - last < TTL_MS) return false;
  lastUpstreamFormatErrorAt.set(key, now);
  return true;
}

export function __resetModelUnavailableThrottleForTests(): void {
  lastEmittedAt.clear();
  lastSilentStreamAt.clear();
  lastUpstreamFormatErrorAt.clear();
}
