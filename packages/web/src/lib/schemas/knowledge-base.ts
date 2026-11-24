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

/**
 * Body for `POST /api/agents/[agentId]/knowledge/passage` — the citation viewer
 * asking which indexed passage of a cited page, slide or Word section the
 * answer drew on (#1268).
 *
 * `path` is the absolute path the citation link carries (the same value the
 * workspace-file route reads from `?path=`); the route checks it against the
 * agent's grants before the index is read. `claim` is the answer's own text
 * citing the source — a ranking hint, capped well above what the viewer sends
 * (600 characters) and never stored. It travels in a body rather than a query
 * string because it is conversation text, which does not belong in access logs.
 */
const citedPassageBase = {
  path: z.string().min(1).max(4096),
  claim: z.string().max(2000).optional(),
};

/*
 * Exactly one anchor, by format: a PDF's `page`, a presentation's `slide`, or
 * a Word document's `heading` path joined with " > " (the spelling a citation
 * shows). Strict objects, so a body naming two anchors is a 400 rather than a
 * silent pick of whichever branch happens to match first.
 */
export const citedPassageSchema = z.union([
  z.strictObject({ ...citedPassageBase, page: z.number().int().min(1).max(99999) }),
  z.strictObject({ ...citedPassageBase, slide: z.number().int().min(1).max(99999) }),
  z.strictObject({ ...citedPassageBase, heading: z.string().trim().min(1).max(2000) }),
]);

export type CitedPassageRequest = z.infer<typeof citedPassageSchema>;

/**
 * Query for `GET /api/agents/[agentId]/knowledge/unsearchable` when it lists
 * one group of the unsearchable documents (#1364) rather than the summary.
 *
 * A group is one of the agent's grants (`root`) and ONE folder directly below
 * it (`folder`); no folder means the files sitting directly in the grant. A
 * folder that is itself a path is refused: it would ask for a subtree the
 * summary never offered. The root is not checked against the grants here —
 * the query answers nothing for a root outside them, so a request can pick a
 * grant but never add one.
 */
export const unsearchableGroupQuerySchema = z
  .object({
    root: z.string().min(1).optional(),
    folder: z
      .string()
      .min(1)
      .refine((value) => !value.includes("/"), "folder is one folder name, not a path")
      .optional(),
  })
  .refine((query) => query.folder === undefined || query.root !== undefined, {
    message: "folder needs a root",
    path: ["folder"],
  });

export type UnsearchableGroupQuery = z.infer<typeof unsearchableGroupQuerySchema>;
