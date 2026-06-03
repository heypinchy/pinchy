// packages/web/src/server/agent-readiness.ts
//
// Runtime-readiness gate for a freshly (re)created agent.
//
// OpenClaw applies a config change to its runtime ASYNCHRONOUSLY: after Pinchy
// writes/applies a new agent, OC's chat-dispatch handler keeps rejecting the id
// with `unknown agent id` until the runtime `agents.list` reflects the change.
// That lag is normally 1–2 s, but on a cold start or under OC 5.3's
// `config.apply` rate-limit it can balloon to ~100 s (see chat-dispatch-retry.ts
// and reference_config_apply_rate_limit_drop in project memory).
//
// `agents.list` (openclaw-node >= 0.12.0) is backed by the SAME runtime view
// (`getRuntimeConfig()`) that OC's chat-dispatch handler checks before accepting
// a message. Verified against OC 2026.5.28: both the `agent` dispatch handler
// (`knownAgents = listAgentIds(getRuntimeConfig())`) and the `agents.list`
// handler (`listAgentsForGateway(getRuntimeConfig())`) read that one view. So
// polling `agents.list` until the agent id appears is an AUTHORITATIVE,
// deterministic readiness signal — the gate `config.get` could never be, because
// `config.get` reads the config FILE, which leads the applied runtime.
//
// Contract: this helper NEVER throws and NEVER blocks chat outright.
//   - Gateway without agents.list (older OC)  → returns false immediately.
//   - agents.list RPC errors transiently      → treated as "not yet present".
//   - agent never appears within the deadline  → returns false.
// In every false case the caller dispatches anyway; `chatWithDispatchRaceRetry`
// remains the backstop, so a readiness-probe miss can only ever cost a little
// latency, never a dropped message.

export interface AgentRuntimeReadinessDeps {
  /** Whether the connected Gateway advertises the `agents.list` RPC. */
  hasAgentsListRpc: () => boolean;
  /**
   * Resolve the agent ids currently present in OC's RUNTIME config (i.e. the
   * `id`s returned by `agents.list`). Rejections are caught by the caller and
   * treated as "agent not yet present".
   */
  listRuntimeAgentIds: () => Promise<string[]>;
  /** Sleep helper, injectable so tests don't wait real time. */
  delay?: (ms: number) => Promise<void>;
  /** Clock, injectable so tests drive the deadline deterministically. */
  now?: () => number;
  /**
   * Observability hook, invoked once per wait that ACTUALLY had to poll (i.e.
   * the agent was not already present on the first check). Skipped on the
   * zero-wait fast path so it does not flood with no-op observations.
   */
  onWaitObserved?: (info: {
    agentId: string;
    waitedMs: number;
    ready: boolean;
    polls: number;
  }) => void;
}

export interface AgentRuntimeReadinessOptions {
  /** Total wall-clock budget to wait for the agent to appear in the runtime. */
  deadlineMs: number;
  /** Delay between polls. Default 500 ms. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 500;

/**
 * Resolves `true` once `agentId` is present in OC's runtime `agents.list`, or
 * `false` if it never appears within `deadlineMs` (or readiness is
 * unobservable on this Gateway). Mirrors the dispatch handler's own predicate:
 * a direct membership check on the runtime agent-id list.
 */
export async function waitForAgentInRuntime(
  agentId: string,
  deps: AgentRuntimeReadinessDeps,
  opts: AgentRuntimeReadinessOptions
): Promise<boolean> {
  // Unobservable on this Gateway → don't burn the deadline polling something
  // that will never answer; let the dispatch-race backstop handle it.
  if (!deps.hasAgentsListRpc()) return false;

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const start = now();
  let polls = 0;
  for (;;) {
    polls++;
    let present = false;
    try {
      present = (await deps.listRuntimeAgentIds()).includes(agentId);
    } catch {
      // Transient agents.list error — treat as "not yet present" and keep
      // polling within the deadline rather than giving up early.
      present = false;
    }

    if (present) {
      // Only report waits that actually had to poll past the first check, so
      // the hot path (agent already ready) stays observation-free.
      if (polls > 1)
        deps.onWaitObserved?.({ agentId, waitedMs: now() - start, ready: true, polls });
      return true;
    }

    const remaining = opts.deadlineMs - (now() - start);
    if (remaining <= 0) {
      deps.onWaitObserved?.({ agentId, waitedMs: now() - start, ready: false, polls });
      return false;
    }
    await delay(Math.min(intervalMs, remaining));
  }
}
