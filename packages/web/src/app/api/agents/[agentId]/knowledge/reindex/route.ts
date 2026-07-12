import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { knowledgeReindexSchema } from "@/lib/schemas/knowledge-base";
import { db } from "@/db";
import { activeAgents, type AgentPluginConfig } from "@/db/schema";
import { ingestDirectory, type IngestDeps } from "@/lib/knowledge/ingest";
import { embedTexts } from "@/lib/knowledge/embeddings";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import { DEFAULT_ORG_ID, EMBEDDING_MODEL } from "@/lib/knowledge/constants";
import { getSetting } from "@/lib/settings";
import { PROVIDERS } from "@/lib/providers";
import { deferAuditLog } from "@/lib/audit-deferred";
import { safeProviderError, type AuditLogEntry, type EntityRef } from "@/lib/audit";

type RouteContext = { params: Promise<{ agentId: string }> };

// Builds (but does not send) the knowledge.reindex audit entry — a pure
// function so every branch shares the same detail shape. Callers pass this
// straight to deferAuditLog(); the eslint pinchy/require-audit-log rule checks
// the handler body's source text for a literal deferAuditLog(...) call, so the
// send stays inline at each call site rather than behind a second indirection.
function reindexAuditEntry(args: {
  agent: EntityRef;
  actorId: string;
  outcome: "success" | "failure";
  pathCount: number;
  indexed: number;
  skipped: number;
  removed: number;
  reason?: string;
}): AuditLogEntry {
  return {
    actorType: "user",
    actorId: args.actorId,
    eventType: "knowledge.reindex",
    resource: `agent:${args.agent.id}`,
    outcome: args.outcome,
    detail: {
      agent: args.agent,
      pathCount: args.pathCount,
      indexed: args.indexed,
      skipped: args.skipped,
      removed: args.removed,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
  };
}

/**
 * POST /api/agents/[agentId]/knowledge/reindex — admin-only manual trigger to
 * (re)ingest an agent's granted knowledge-base folders into the corpus-wide
 * index. This is the minimal manual trigger (MVP); a scheduled sweep + progress
 * UI is Phase 2.
 *
 * Access boundary: admin-only (`withAdmin`) — index management is an admin
 * action. The set of folders reindexed is resolved from the SAME source the
 * search route scopes retrieval by: the agent's admin-configured `pinchy-files`
 * `allowed_paths`. An optional `paths` body can narrow to a subset but can
 * NEVER widen past the granted set (any path not granted is dropped), so the
 * body can't be used to index arbitrary host directories.
 *
 * Sync execution is fine for the MVP (the sample corpus is small). A
 * large-corpus reindex needs async execution + progress reporting — that's
 * Phase 2 (see the implementation plan); do NOT block a request on a
 * multi-minute ingest in production.
 */
export const POST = withAdmin<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;
  const actorId = session.user.id!;

  const parsed = await parseRequestBody(knowledgeReindexSchema, request);
  if ("error" in parsed) return parsed.error;
  const requestedPaths = parsed.data.paths;

  const [agent] = await db.select().from(activeAgents).where(eq(activeAgents.id, agentId)).limit(1);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const agentRef: EntityRef = { id: agent.id, name: agent.name };
  const grantedPaths =
    (agent.pluginConfig as AgentPluginConfig | null)?.["pinchy-files"]?.allowed_paths ?? [];

  // A requested subset can only ever narrow the granted set — never widen it.
  // Any requested path outside the agent's allowlist is silently dropped.
  const targetPaths = requestedPaths
    ? requestedPaths.filter((p) => grantedPaths.includes(p))
    : grantedPaths;

  // Nothing granted (or nothing left after narrowing) — an honest no-op, not an
  // error. Still audited so the action is on the record.
  if (targetPaths.length === 0) {
    deferAuditLog(
      reindexAuditEntry({
        agent: agentRef,
        actorId,
        outcome: "success",
        pathCount: 0,
        indexed: 0,
        skipped: 0,
        removed: 0,
      })
    );
    return NextResponse.json({ indexed: 0, skipped: 0, removed: 0, pathCount: 0 });
  }

  // The embedding model is fixed (bge-m3) but still needs a reachable Ollama
  // base URL — the same admin-configured "Ollama (Local)" provider setting the
  // search route and the chat/vision path already resolve.
  const ollamaBaseUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);
  if (!ollamaBaseUrl) {
    deferAuditLog(
      reindexAuditEntry({
        agent: agentRef,
        actorId,
        outcome: "failure",
        pathCount: targetPaths.length,
        indexed: 0,
        skipped: 0,
        removed: 0,
        reason: "ollama_not_configured",
      })
    );
    return NextResponse.json(
      { error: "Knowledge base embedding endpoint not configured" },
      { status: 503 }
    );
  }

  const deps: IngestDeps = {
    embed: (texts) => embedTexts(texts, { baseUrl: ollamaBaseUrl, model: EMBEDDING_MODEL }),
    extractPdf: extractPdfPages,
  };

  let indexed = 0;
  let skipped = 0;
  let removed = 0;
  try {
    for (const path of targetPaths) {
      const result = await ingestDirectory(DEFAULT_ORG_ID, path, deps);
      indexed += result.indexed;
      skipped += result.skipped;
      removed += result.removed;
    }
  } catch (err) {
    // safeProviderError scrubs emails + caps length; the underlying error could
    // echo a filesystem path, which this HMAC-signed audit row must not carry.
    deferAuditLog(
      reindexAuditEntry({
        agent: agentRef,
        actorId,
        outcome: "failure",
        pathCount: targetPaths.length,
        indexed,
        skipped,
        removed,
        reason: safeProviderError(err instanceof Error ? err.message : "reindex_failed"),
      })
    );
    return NextResponse.json({ error: "Knowledge base reindex failed" }, { status: 500 });
  }

  deferAuditLog(
    reindexAuditEntry({
      agent: agentRef,
      actorId,
      outcome: "success",
      pathCount: targetPaths.length,
      indexed,
      skipped,
      removed,
    })
  );

  return NextResponse.json({ indexed, skipped, removed, pathCount: targetPaths.length });
});
