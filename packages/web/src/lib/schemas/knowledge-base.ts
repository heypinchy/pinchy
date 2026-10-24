import { z } from "zod";

import { INDEX_SCHEDULE_TIME_PATTERN } from "@/lib/knowledge/index-schedule";

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
  /**
   * Opt-in: also search `archived` documents (OLD/-style folders — see
   * archive-paths.ts). Default retrieval excludes them so expired material
   * cannot outrank current documents (#858); "search the archive too" stays
   * an explicit request.
   */
  includeArchived: z.boolean().optional(),
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

/**
 * Body for `PUT /api/settings/knowledge-index-schedule` — whether Pinchy
 * reindexes every knowledge-base agent on its own once a night, and at what
 * org-local time. The whole schedule, not a patch: it is two fields, and a
 * partial update would make "what is the schedule now?" depend on the order
 * two admins saved in.
 */
export const knowledgeIndexScheduleSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(INDEX_SCHEDULE_TIME_PATTERN, "Use a 24-hour time such as 02:00 or 23:30."),
});

export type KnowledgeIndexScheduleRequest = z.infer<typeof knowledgeIndexScheduleSchema>;
