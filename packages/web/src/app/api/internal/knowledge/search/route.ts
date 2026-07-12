import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { eq } from "drizzle-orm";

import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { knowledgeSearchSchema } from "@/lib/schemas/knowledge-base";
import { db } from "@/db";
import { activeAgents, type AgentPluginConfig } from "@/db/schema";
import { retrieve, type RetrievedChunk } from "@/lib/knowledge/retrieve";
import { embedTexts } from "@/lib/knowledge/embeddings";
import { DEFAULT_ORG_ID, EMBEDDING_MODEL } from "@/lib/knowledge/constants";
import { getSetting } from "@/lib/settings";
import { PROVIDERS } from "@/lib/providers";
import { deferAuditLog } from "@/lib/audit-deferred";
import { safeProviderError, type AuditLogEntry, type EntityRef } from "@/lib/audit";

function docRefsFromChunks(chunks: RetrievedChunk[]): EntityRef[] {
  const seen = new Map<string, string>();
  for (const chunk of chunks) {
    if (!seen.has(chunk.documentId)) {
      seen.set(chunk.documentId, basename(chunk.sourcePath));
    }
  }
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

// Builds (but does not send) the retrieval.query audit entry — a pure
// function so every branch below shares the same detail shape. Callers pass
// this straight to deferAuditLog(); the eslint pinchy/require-audit-log rule
// checks the POST body's source text for a literal deferAuditLog(...) call,
// so the send itself stays inline at each call site rather than behind a
// second layer of indirection.
function retrievalAuditEntry(args: {
  agentId: string;
  agentName: string | null;
  queryHash: string;
  outcome: "success" | "failure";
  resultCount: number;
  returnedDocumentIds: EntityRef[];
  reason?: string;
}): AuditLogEntry {
  return {
    actorType: "agent",
    actorId: args.agentId,
    eventType: "retrieval.query",
    resource: `agent:${args.agentId}`,
    outcome: args.outcome,
    detail: {
      agent: { id: args.agentId, name: args.agentName ?? args.agentId },
      queryHash: args.queryHash,
      resultCount: args.resultCount,
      returnedDocumentIds: args.returnedDocumentIds,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
  };
}

/**
 * Internal retrieval endpoint for the (thin) `pinchy-knowledge` plugin's
 * `knowledge_search` tool — gateway-token authed, mirroring the
 * credential-proxy pattern (see `/api/internal/integrations/:id/credentials`).
 * Resolves `agentId` -> `allowedPaths` from the SAME admin-configured
 * `pinchy-files` path allowlist that already scopes the agent's file access
 * (`agent.pluginConfig["pinchy-files"].allowed_paths`, see
 * `openclaw-config/build.ts`'s `adminPaths`) — an agent's KB visibility is
 * exactly the folders an admin has granted it, no separate allowlist to drift.
 * `retrieve()` denies by default on an empty allowedPaths list.
 *
 * Audited deliberately even though retrieval is read-only (design doc §8a):
 * the audit trail must show which documents an agent's answer drew on. The
 * raw query is never persisted — only a one-way `queryHash`, since a KB
 * question can itself carry PII.
 */
export async function POST(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(knowledgeSearchSchema, request);
  if ("error" in parsed) return parsed.error;
  const { query, agentId } = parsed.data;

  const queryHash = createHash("sha256").update(query).digest("hex");

  const [agent] = await db.select().from(activeAgents).where(eq(activeAgents.id, agentId)).limit(1);
  if (!agent) {
    deferAuditLog(
      retrievalAuditEntry({
        agentId,
        agentName: null,
        queryHash,
        outcome: "failure",
        resultCount: 0,
        returnedDocumentIds: [],
        reason: "agent_not_found",
      })
    );
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const allowedPaths =
    (agent.pluginConfig as AgentPluginConfig | null)?.["pinchy-files"]?.allowed_paths ?? [];

  // The embedding model is fixed (bge-m3) and independent of any agent's chat
  // model (see embeddings.ts) — but it still needs a reachable Ollama base
  // URL. Reused from the SAME admin-configured "Ollama (Local)" provider
  // setting the chat/vision path already resolves (packages/web/src/lib/
  // provider-models.ts's ollamaUrl), rather than a new env var: it's the one
  // platform-wide (not per-agent) Ollama endpoint Pinchy already asks admins
  // to configure, and bge-m3 is expected to be pulled on that same instance.
  const ollamaBaseUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);
  if (!ollamaBaseUrl) {
    deferAuditLog(
      retrievalAuditEntry({
        agentId: agent.id,
        agentName: agent.name,
        queryHash,
        outcome: "failure",
        resultCount: 0,
        returnedDocumentIds: [],
        reason: "ollama_not_configured",
      })
    );
    return NextResponse.json(
      { error: "Knowledge base embedding endpoint not configured" },
      { status: 503 }
    );
  }

  let chunks: RetrievedChunk[];
  try {
    chunks = await retrieve(DEFAULT_ORG_ID, allowedPaths, query, {
      embed: (texts) => embedTexts(texts, { baseUrl: ollamaBaseUrl, model: EMBEDDING_MODEL }),
    });
  } catch (err) {
    // safeProviderError scrubs emails and caps length — the underlying error
    // could in principle echo request content (e.g. a misconfigured Ollama
    // endpoint reflecting the request body), and this reason string lands in
    // the same HMAC-signed, append-only audit row as everything else.
    deferAuditLog(
      retrievalAuditEntry({
        agentId: agent.id,
        agentName: agent.name,
        queryHash,
        outcome: "failure",
        resultCount: 0,
        returnedDocumentIds: [],
        reason: safeProviderError(err instanceof Error ? err.message : "retrieval_failed"),
      })
    );
    return NextResponse.json({ error: "Knowledge base retrieval failed" }, { status: 502 });
  }

  const returnedDocumentIds = docRefsFromChunks(chunks);

  deferAuditLog(
    retrievalAuditEntry({
      agentId: agent.id,
      agentName: agent.name,
      queryHash,
      outcome: "success",
      resultCount: chunks.length,
      returnedDocumentIds,
    })
  );

  return NextResponse.json({
    results: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      text: chunk.text,
      sourcePath: chunk.sourcePath,
      page: chunk.page,
      docName: basename(chunk.sourcePath),
    })),
  });
}
