import { z } from "zod";

/**
 * Body the pinchy-approvals gate sends to the internal gate-check endpoint.
 * The route owns digest computation and the requester derivation.
 */
export const gateCheckSchema = z.object({
  agentId: z.string().min(1),
  /** The OpenClaw session the call belongs to. Optional because some run
   * contexts carry none — the route refuses a gated call in that case rather
   * than rejecting the request, so the gate gets an actionable answer instead
   * of a 400 it can only read as "service unavailable". */
  sessionKey: z.string().min(1).optional(),
  /** Human who triggered the call (Telegram senderId etc.); falls back to the
   * userId encoded in the session key. */
  senderId: z.string().optional(),
  toolName: z.string().min(1),
  /** The individual OpenClaw tool call. Optional for the same reason as
   * `sessionKey`: some run contexts carry none, and a gated call without one
   * must get an answer it can act on rather than a 400. */
  toolCallId: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});
export type GateCheckBody = z.infer<typeof gateCheckSchema>;

/**
 * What OpenClaw finally did with a parked call, reported by the gate's
 * `onResolution` callback. Unlike the decision route this also carries the
 * outcomes no button produces — `timeout` and `cancelled`.
 */
export const resolutionSchema = z.object({
  toolCallId: z.string().min(1),
  /** The session the runtime reported on. A tool call id is only as unique as
   * the model provider makes it, so this is what keeps a report from spending a
   * grant in someone else's session. Optional for the same reason as
   * `sessionKey` on the gate check: narrowing must not reject a report a run
   * context could not fully describe. */
  sessionKey: z.string().min(1).optional(),
  decision: z.enum(["allow-once", "allow-always", "deny", "timeout", "cancelled"]),
});
export type ResolutionBody = z.infer<typeof resolutionSchema>;

/** A requester's approve/deny decision on their own pending confirmation. */
export const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().max(500).optional(),
});
export type DecisionBody = z.infer<typeof decisionSchema>;
