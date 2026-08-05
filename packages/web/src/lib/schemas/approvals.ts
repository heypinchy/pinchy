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
  params: z.record(z.string(), z.unknown()).optional().default({}),
});
export type GateCheckBody = z.infer<typeof gateCheckSchema>;

/** A requester's approve/deny decision on their own pending confirmation. */
export const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().max(500).optional(),
});
export type DecisionBody = z.infer<typeof decisionSchema>;
