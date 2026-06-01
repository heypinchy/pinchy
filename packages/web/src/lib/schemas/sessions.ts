import { z } from "zod";

/**
 * Body for `POST /api/agents/[agentId]/sessions/compact`.
 *
 * `maxLines` is optional — when omitted, OpenClaw uses its own default
 * compaction threshold. Shared between the route handler (parseRequestBody)
 * and the client component (typed request body via z.infer).
 */
export const compactSessionSchema = z.object({
  maxLines: z.number().int().positive().max(100_000).optional(),
});

export type CompactSessionRequest = z.infer<typeof compactSessionSchema>;
