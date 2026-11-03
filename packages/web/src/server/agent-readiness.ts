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
// `agents.list` (openclaw-node >= 0.12.0) and OC's `agent` dispatch handler
// read the SAME runtime view: re-verified against OC 2026.7.1, the dispatch
// handler checks `listAgentIds(context.getRuntimeConfig())` and `agents.list`
// answers `listAgentsForGateway(context.getRuntimeConfig())`. That is what makes
// it a better gate than `config.get`, which reads the config FILE and leads the
// applied runtime.
//
// Same view, different predicate. `listAgentIds` returns the configured
// `agents.list` ids (or just `main` when that list is empty).
// `listAgentsForGateway` adds every directory under `<stateDir>/agents/` and
// filters them back down to the configured ids — but ONLY when the configured
// list is non-empty. While the runtime list is empty (right after a gateway
// restart, before Pinchy's agents apply), `agents.list` therefore reports every
// agent that has ever had a directory on disk, while the dispatch handler
// rejects all of them with `unknown agent id`. CI run 41569393728 hit exactly
// this: the gate said "ready" and the dispatch kept racing.
//
// `dispatchableAgentIds` closes that gap. It accepts an entry if either of two
// signals says it came from the configured list:
//   1. `defaultId` is not `main`. With a non-empty configured list OC's default
//      is a configured agent (Pinchy ids are UUIDs, never `main`) and the
//      response is already filtered down to configured ids. With an empty list
//      the default is `main`.
//   2. The entry carries the configured `name` / `identity` (Pinchy always
//      writes `name`). A disk-only entry has neither.
// In OC 2026.7.1 signal 1 alone decides; signal 2 is the backup. The OR is a
// trade: a future OC must break BOTH signals before the gate stops ever saying
// "ready", but breaking EITHER one (a non-`main` default for an empty list, or
// an identity on disk-only entries) brings back a false "ready". On the chat
// path that is bounded by the retry loop, which stops trusting a "ready" the
// next dispatch contradicts (chat-dispatch-retry.ts). The inbox sweep has no
// such loop: a false "ready" there lets the run dispatch into the race, which
// fails that email terminally and notifies the user (see
// lib/email-workflows/run-adapter.ts). The other direction is loud, not
// lossless: a gate that never says "ready" makes a chat wait out the whole
// retry budget and fail, and makes the inbox sweep defer every email.
//
// Polling cost is safe under contention: `agents.list` is a READ. Verified
// against OC 2026.5.28's method descriptors — `config.apply` carries
// `controlPlaneWrite: true` (the ~3-per-45s write rate-limit bucket that
// motivated this whole gate), but `agents.list` does NOT, so polling it cannot
// consume a write slot or contend with the very apply we're waiting on. The
// default 500 ms interval is therefore a cheap read even across the full budget.
//
// Contract: this helper NEVER throws and NEVER blocks chat outright.
//   - Gateway without agents.list (older OC)  → returns false immediately.
//   - agents.list RPC errors transiently      → treated as "not yet present".
//   - agent never appears within the deadline  → returns false.
// A false answer never drops a message silently: `chatWithDispatchRaceRetry`
// then backs off and re-dispatches while budget remains, and surfaces the race
// error once it runs out. Note the chat path hands this helper the WHOLE
// remaining retry budget as its deadline, so a gate that never confirms uses up
// that budget in one wait and the chat fails with the race error — the
// "loud, not lossless" case described above.

import type { AgentsListResult } from "openclaw-node";

/**
 * OC's `DEFAULT_AGENT_ID`: the default agent when no agent is configured, and
 * the only id its dispatch handler accepts then.
 */
const OPENCLAW_FALLBACK_AGENT_ID = "main";

/**
 * The configured (Pinchy) agent ids from an `agents.list` result — the ones
 * OC's `agent` dispatch handler accepts — never agent directories OC found on
 * disk, and never the `main` fallback OC answers with while the configured list
 * is empty (Pinchy never dispatches to `main`). See the file header for why
 * `agents.list` and the dispatch handler differ.
 */
export function dispatchableAgentIds(result: AgentsListResult): string[] {
  const configuredListIsNonEmpty =
    typeof result.defaultId === "string" && result.defaultId !== OPENCLAW_FALLBACK_AGENT_ID;
  return result.agents
    .filter((agent) => configuredListIsNonEmpty || Boolean(agent.name) || agent.identity != null)
    .map((agent) => agent.id);
}

export interface AgentRuntimeReadinessDeps {
  /** Whether the connected Gateway advertises the `agents.list` RPC. */
  hasAgentsListRpc: () => boolean;
  /**
   * Resolve the agent ids OC's dispatch handler currently accepts — pass the
   * `agents.list` result through `dispatchableAgentIds`, not its raw ids.
   * Rejections are caught by the caller and treated as "agent not yet present".
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
 * Resolves `true` once `agentId` is among the ids `listRuntimeAgentIds`
 * returns, or `false` if it never appears within `deadlineMs` (or readiness is
 * unobservable on this Gateway). Mirrors the dispatch handler's own predicate
 * only when those ids are filtered through `dispatchableAgentIds`.
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
