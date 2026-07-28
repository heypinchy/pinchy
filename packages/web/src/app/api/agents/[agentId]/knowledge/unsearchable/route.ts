import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { activeAgents, type AgentPluginConfig } from "@/db/schema";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { listUnsearchableDocuments } from "@/lib/knowledge/unsearchable";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/knowledge/unsearchable — WHICH documents the index
 * holds but cannot search, not just how many (#935).
 *
 * The reindex status route already reports `unsearchable` as a count. A count
 * nobody can expand is the silent half of a known gap: the agent answers "I
 * found nothing" and the reader hears a statement about the world rather than
 * about the index. Named after that counter on purpose — this is the list
 * behind it, and `unreadable` is the word the docs already spend on `failed`,
 * which (see lib/knowledge/unsearchable.ts) is the one state this cannot show.
 *
 * Wider window than the counter, though: a run counts only what it processed,
 * this answers for everything currently in scope. Callers rendering the two
 * together must say which is which.
 *
 * Scope: the agent's SAVED `pinchy-files` grants — the same allow-list that
 * scopes retrieval, resolved from the same place. Never from the request: a
 * path parameter here would turn a diagnostics panel into a way to enumerate
 * documents the agent was never granted.
 *
 * Admin-only, like the reindex it explains.
 */
// audit-exempt: read-only projection of already-stored index state, no state change.
export const GET = withAdmin<RouteContext>(async (_request, { params }) => {
  const { agentId } = await params;

  const [agent] = await db.select().from(activeAgents).where(eq(activeAgents.id, agentId)).limit(1);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const allowedPaths =
    (agent.pluginConfig as AgentPluginConfig | null)?.["pinchy-files"]?.allowed_paths ?? [];

  // Denies by default on an empty grant list (see listUnsearchableDocuments), so
  // an agent granted nothing reports nothing rather than the whole corpus.
  const { documents, total } = await listUnsearchableDocuments(DEFAULT_ORG_ID, allowedPaths);

  return NextResponse.json({ documents, total });
});
