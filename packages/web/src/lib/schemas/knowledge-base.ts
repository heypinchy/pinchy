import { z } from "zod";

/**
 * Body for `POST /api/internal/knowledge/search` — the retrieval endpoint the
 * (thin) `pinchy-knowledge` OpenClaw plugin's `knowledge_search` tool calls,
 * gateway-token authed, mirroring the credential-proxy pattern used by
 * pinchy-files/pinchy-web. `agentId` is required (not derived from a session
 * key like channel-messages) because knowledge_search is a synchronous tool
 * call, not a channel-hook capture — the plugin already knows which agent is
 * asking and passes it straight through. The route resolves agentId -> orgId
 * + allowedPaths server-side; this schema does not accept either directly.
 */
export const knowledgeSearchSchema = z.object({
  /** The user's/agent's natural-language question. Never logged in plaintext. */
  query: z.string().trim().min(1).max(4000),
  agentId: z.string().trim().min(1),
});

export type KnowledgeSearchRequest = z.infer<typeof knowledgeSearchSchema>;

/**
 * Body for `POST /api/agents/[agentId]/knowledge/reindex` — the admin-only
 * manual ingest trigger. `agentId` comes from the route path, not the body.
 * `paths` is an optional subset of the agent's granted folders to reindex; when
 * omitted (the common case) the route reindexes ALL of the agent's granted
 * folders. Any supplied path that is not among the agent's granted folders is
 * ignored server-side — the body can only ever narrow the granted set, never
 * widen it past the agent's `pinchy-files` allowlist.
 */
export const knowledgeReindexSchema = z.object({
  paths: z.array(z.string().trim().min(1)).optional(),
});

export type KnowledgeReindexRequest = z.infer<typeof knowledgeReindexSchema>;
