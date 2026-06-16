import { z } from "zod";

/**
 * Body the pinchy-approvals gate sends to the internal gate-check endpoint.
 * The route owns digest computation and the requester derivation.
 */
export const gateCheckSchema = z.object({
  agentId: z.string().min(1),
  sessionKey: z.string().min(1),
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
