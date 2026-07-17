/**
 * Production dependencies for the reconciliation sweep (#139).
 *
 * The sweep engine (`runReconciliationSweep`) and the run adapter
 * (`createOpenClawRunAgent`) are both written against injected seams so they can
 * be tested without a mailbox or a Gateway. This module is where those seams
 * meet reality: real mailboxes via {@link createEmailPort}, real runs via the
 * live OpenClaw client.
 *
 * It lives apart from the scheduler (`inbox-sweep.ts`) on purpose — the
 * scheduler stays a pure cadence with no knowledge of DB or Gateway, which is
 * what lets its tests run with no mocks at all.
 */
import { eq } from "drizzle-orm";
import type { OpenClawClient } from "openclaw-node";

import { db } from "@/db";
import { agents } from "@/db/schema";
import { createEmailPort } from "@/lib/email-workflows/port";
import { createOpenClawRunAgent } from "@/lib/email-workflows/run-adapter";
import type { SweepDeps } from "@/lib/email-workflows/sweep";
import { waitForAgentInRuntime } from "@/server/agent-readiness";

/** The slice of the gateway client the sweep's dependencies need. */
export type SweepGatewayClient = Pick<
  OpenClawClient,
  "chat" | "chatAbort" | "hasMethod" | "agents" | "isConnected"
>;

/**
 * How long to wait for an agent to land in OpenClaw's runtime before deferring
 * the email.
 *
 * Deliberately well below the ~100 s worst-case `config.apply` lag the chat path
 * budgets for: here a miss is cheap and lossless (the adapter defers, the row
 * stays `processing`, the next sweep retries it), whereas waiting blocks the
 * sweep for every email behind it. In steady state this costs one `agents.list`
 * read and returns immediately.
 */
export const DEFAULT_READINESS_DEADLINE_MS = 30_000;

/** The agent's `provider/model` ref, or null if the agent is gone. */
export async function loadAgentModel(agentId: string): Promise<string | null> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { model: true },
  });
  return agent?.model ?? null;
}

/**
 * The run adapter's runtime-readiness gate, over three distinct Gateway states
 * that the underlying primitives blur together.
 *
 * The adapter reads `false` as "defer this email", and `waitForAgentInRuntime`
 * answers `false` for two very different situations:
 *
 *   1. The agent is not in the runtime yet — a real, transient miss. Deferring
 *      is exactly right: the next sweep retries and nothing is lost.
 *   2. The Gateway has no `agents.list` RPC, so readiness is *unobservable*.
 *      Deferring on that would be catastrophic and completely silent — every
 *      email claimed, deferred, reset, re-claimed, deferred again, forever,
 *      while the workflow reports `active` and processes nothing.
 *
 * Unobservable is not "no", so case 2 proceeds and lets the run answer: a
 * genuinely unknown agent id fails that one run loudly, which is strictly better
 * than an invisible loop.
 *
 * But `hasMethod` cannot separate case 2 from a third state — a Gateway that is
 * simply not connected. The client's advertised-method list is filled at the
 * hello-ok handshake and is empty until then, so "too old" and "not connected
 * yet" look identical through it. Proceeding while disconnected would claim the
 * email, fail the chat, and (any run throw being terminal to the dispatcher)
 * mark a never-examined mail `failed` and notify the user. `isConnected` is the
 * distinguisher, checked first: no connection means defer, which costs one
 * cadence and loses nothing.
 */
export function createAgentReadinessGate(
  client: SweepGatewayClient,
  opts: { deadlineMs?: number } = {}
): (agentId: string) => Promise<boolean> {
  return async (agentId) => {
    if (!client.isConnected) return false;
    if (!client.hasMethod("agents.list")) return true;
    return waitForAgentInRuntime(
      agentId,
      {
        hasAgentsListRpc: () => true,
        listRuntimeAgentIds: async () => (await client.agents.list()).agents.map((a) => a.id),
      },
      { deadlineMs: opts.deadlineMs ?? DEFAULT_READINESS_DEADLINE_MS }
    );
  };
}

/** Everything {@link import("@/lib/email-workflows/sweep").runReconciliationSweep} needs to run for real. */
export function buildSweepDeps(client: SweepGatewayClient): SweepDeps {
  return {
    createPort: createEmailPort,
    runAgent: createOpenClawRunAgent({
      client,
      loadAgentModel,
      waitForAgentReady: createAgentReadinessGate(client),
    }),
  };
}
