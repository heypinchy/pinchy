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

/**
 * Opaque, client-supplied identifier for one chat within a (user, agent)
 * pair. It becomes the trailing segment of the OpenClaw session key
 * (`agent:<agentId>:direct:<userId>:<chatId>`), so it must stay free of the
 * `:` delimiter and other path/whitespace characters. Lowercase alphanumerics
 * and dashes only (nanoid-compatible), 1–64 chars.
 */
export const chatIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
