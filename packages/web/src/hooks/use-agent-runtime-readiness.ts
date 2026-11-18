"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";

/**
 * Poll interval and total budget for {@link useAgentRuntimeReadiness}.
 *
 * The budget is deliberately the SAME 30 s that `POST /api/setup/provider` used
 * to spend inside the request before #1150 — the wait did not get longer, it
 * got visible. Anything shorter would hand the user through into a chat that is
 * still going to race OpenClaw's reload; anything longer starts to look like
 * the hang this replaced.
 */
export const RUNTIME_READY_POLL_MS = 1_000;
export const RUNTIME_READY_BUDGET_MS = 30_000;

/**
 * - `unknown` — nothing to wait for (no agent id: the caller's save never
 *   reached OpenClaw, so there is no reload coming).
 * - `preparing` — OpenClaw does not carry the agent yet.
 * - `ready` — a chat dispatched now would not hit "unknown agent id".
 * - `slow` — the budget ran out. Not an error: the runtime is still catching
 *   up, and the caller should let the user through rather than trap them.
 */
export type AgentRuntimeReadiness = "unknown" | "preparing" | "ready" | "slow";

/**
 * Watch OpenClaw's runtime until it can dispatch to `agentId`.
 *
 * Why this exists on the client at all (#1150): Pinchy pushes config to
 * OpenClaw in the background, so an agent reaches OC's `agents.list` some time
 * after the route that created it has answered. That gap is normally
 * sub-second, but on a fresh install it is not — writing the first secrets.json
 * restarts the gateway, the restarts spend OC's ~3-per-45 s `config.apply`
 * budget, and Pinchy's push is then parked for the advertised retry-after (49 s
 * in the run this was measured on).
 *
 * The setup wizard used to absorb that gap by leaving `POST /api/setup/provider`
 * open, which turned a legitimate wait into a disabled button and a spinner
 * nobody can tell from a hang. Polling it here instead means the wait can be
 * named, bounded, and escaped.
 *
 * `GET /api/health/openclaw?agentId=…` is the existing endpoint for exactly
 * this question — it reports `agentDispatchable`, i.e. whether OC's
 * `agents.list` carries the id right now. It is unauthenticated and returns no
 * agent metadata, and every failure mode on its side already collapses to
 * `agentDispatchable: false`, so this poll never has to interpret an error.
 */
export function useAgentRuntimeReadiness(agentId: string | null): AgentRuntimeReadiness {
  // Only the two OUTCOMES are stored, and they carry the id they were reached
  // for. `unknown` and `preparing` are derived below rather than written here,
  // so the effect never has to setState synchronously to reset itself when the
  // id changes — that would be a cascading render, and the derivation is the
  // shorter way to say the same thing.
  const [outcome, setOutcome] = useState<{ agentId: string; state: "ready" | "slow" } | null>(null);

  useEffect(() => {
    if (!agentId) return;

    let cancelled = false;

    // The budget runs on its own timer rather than being read between polls,
    // and that is the load-bearing part. `apiGet` issues a bare `fetch` with no
    // signal, and the endpoint behind it waits on an OpenClaw RPC — so a
    // gateway wedged mid-restart, or a Pinchy container that goes away between
    // two polls, suspends the loop wherever it happens to be. A deadline only
    // consulted after the request settles is not a deadline: the caller would
    // stay in `preparing` for as long as the browser keeps the socket open,
    // which is precisely the unbounded wait this hook exists to replace.
    const budget = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      setOutcome({ agentId, state: "slow" });
    }, RUNTIME_READY_BUDGET_MS);

    void (async () => {
      while (!cancelled) {
        try {
          const health = await apiGet<{ agentDispatchable?: boolean }>(
            `/api/health/openclaw?agentId=${encodeURIComponent(agentId)}`
          );
          if (cancelled) return;
          if (health.agentDispatchable) {
            clearTimeout(budget);
            setOutcome({ agentId, state: "ready" });
            return;
          }
        } catch {
          // A gateway that is mid-restart is the common case here, not an
          // anomaly — keep polling until the budget says otherwise.
        }
        await new Promise((resolve) => setTimeout(resolve, RUNTIME_READY_POLL_MS));
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(budget);
    };
  }, [agentId]);

  if (!agentId) return "unknown";
  return outcome?.agentId === agentId ? outcome.state : "preparing";
}
