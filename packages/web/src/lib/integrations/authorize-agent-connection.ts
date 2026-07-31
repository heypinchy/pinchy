/**
 * Cross-checks that the agent asking for a connection's credentials was
 * actually granted that connection (#987).
 *
 * The credentials endpoint used to authorize on the gateway token alone. That
 * token is a single shared secret that `openclaw-config/build.ts` inlines into
 * EVERY plugin's config block, so possession of it proved only "some code
 * inside the OpenClaw container is asking" — never "this agent may have these
 * credentials". Any plugin could name any `connectionId` and receive a
 * decrypted Odoo password or mailbox token for an agent it has no relationship
 * with.
 *
 * What this is, and what it is not: the agent id is asserted by the caller, so
 * code that already runs inside the container can still name a different one.
 * This closes the accidental path (a plugin bug, a config carrying the wrong
 * connectionId) and makes the deliberate one leave an audit row, but it is
 * defense in depth on top of the container boundary — not a replacement for
 * it. The structural fix is scoped per-agent tokens so possession stops being
 * instance-wide authority; that is tracked separately in #987's follow-up note
 * and needs an OpenClaw-side change to hand each agent its own token.
 */

import { and, count, eq } from "drizzle-orm";

import { db } from "@/db";
import { activeAgents, agentConnectionPermissions, integrationConnections } from "@/db/schema";
import type { IntegrationConnectionType } from "@/db/enums";

/**
 * The tools that grant an agent the instance-wide web-search connection.
 *
 * Kept beside the rule rather than imported from the tool registry on purpose:
 * this is the authorization list, and it must change only when someone means
 * to widen who can read the Brave API key.
 */
export const WEB_SEARCH_TOOLS: readonly string[] = ["pinchy_web_search", "pinchy_web_fetch"];

export type ConnectionForAuth = {
  id: string;
  type: IntegrationConnectionType;
  name: string | null;
};

export type AgentForAuth = {
  id: string;
  name: string | null;
  allowedTools: string[];
};

export type ConnectionAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "agent-unknown" | "connection-unknown" | "not-granted" };

/**
 * The rule itself. Pure, so every branch is checkable without a database.
 *
 * `grantCount` is the number of `agent_connection_permissions` rows for this
 * (agent, connection) pair — the table stores one row per model+operation, so
 * any positive count means the pair was granted.
 */
export function decideConnectionAccess(
  agent: AgentForAuth | null,
  connection: ConnectionForAuth | null,
  grantCount: number
): ConnectionAccessDecision {
  // Connection first: a missing connection is answered by the route's existing
  // "no longer connected" 404, which is what an admin needs to see. Checking
  // the agent first would turn that into a 403 for anyone whose agent id is
  // also wrong, and would let a caller distinguish "connection exists" from
  // "connection does not" purely by varying the agent id.
  if (!connection) return { allowed: false, reason: "connection-unknown" };
  if (!agent) return { allowed: false, reason: "agent-unknown" };

  // The web-search connection is instance-wide — `build.ts` writes the same
  // connection id into every agent's plugin config and gates access on the
  // agent's tool list, so there are no permission rows to count. Requiring one
  // here would silently revoke web search across the whole instance; reading
  // the tool list instead asks exactly the question the config emission asked.
  if (connection.type === "web-search") {
    const granted = agent.allowedTools.some((tool) => WEB_SEARCH_TOOLS.includes(tool));
    return granted ? { allowed: true } : { allowed: false, reason: "not-granted" };
  }

  return grantCount > 0 ? { allowed: true } : { allowed: false, reason: "not-granted" };
}

/**
 * Loads the three facts `decideConnectionAccess` needs and applies it.
 *
 * `activeAgents` rather than `agents`: a soft-deleted agent must not keep
 * pulling credentials, and its permission rows outlive it — `deleteAgent`
 * clears them, but a row that survived a partial delete must not be the only
 * thing standing between a dead agent and a live password.
 */
export async function authorizeAgentConnection(
  agentId: string,
  connectionId: string
): Promise<ConnectionAccessDecision & { agent: AgentForAuth | null }> {
  const [connectionRow] = await db
    .select({
      id: integrationConnections.id,
      type: integrationConnections.type,
      name: integrationConnections.name,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);

  const [agentRow] = await db
    .select({
      id: activeAgents.id,
      name: activeAgents.name,
      allowedTools: activeAgents.allowedTools,
    })
    .from(activeAgents)
    .where(eq(activeAgents.id, agentId))
    .limit(1);

  const agent: AgentForAuth | null = agentRow
    ? { id: agentRow.id, name: agentRow.name, allowedTools: agentRow.allowedTools ?? [] }
    : null;

  const [grants] = await db
    .select({ n: count() })
    .from(agentConnectionPermissions)
    .where(
      and(
        eq(agentConnectionPermissions.agentId, agentId),
        eq(agentConnectionPermissions.connectionId, connectionId)
      )
    );

  const connection: ConnectionForAuth | null = connectionRow ?? null;

  return { ...decideConnectionAccess(agent, connection, grants?.n ?? 0), agent };
}
