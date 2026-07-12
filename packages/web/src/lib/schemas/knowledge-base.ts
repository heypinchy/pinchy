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
