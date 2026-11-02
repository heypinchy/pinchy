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
  /**
   * Taken as parsed, not rebuilt: `z.record` copies the object by assignment, and
   * `out["__proto__"] = …` hits the prototype setter — the key vanished from the
   * digest and the card while the tool, reading the raw JSON, could still receive
   * it. JSON.parse makes every key, `__proto__` included, an own data property;
   * this keeps them all.
   */
  params: z
    .custom<Record<string, unknown>>(
      (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      { message: "params must be an object" }
    )
    .optional()
    .default({}),
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

/**
 * How many held card ids the inbox poll names in `GET /api/approvals?known=`,
 * and how many the route reads. Shared so the two cannot drift.
 *
 * There is no real maximum to derive this from: MAX_PENDING_PER_REQUESTER
 * (20) bounds one person's open cards on ONE agent, and a person may work with
 * any number of agents. So the bound comes from the request instead. The ids
 * ride in the query string at ~37 characters each; 200 of them are ~7.4 KB,
 * inside the 8 KB request line common proxies accept and well inside Node's
 * 16 KB header limit. Past it the poll would fail outright — and the poll is
 * the only way a card reaches the screen. A person holding more than 200
 * pending cards has the rest of their summaries re-sent on every poll:
 * wasteful, never wrong, and far past anything a person works through.
 */
export const MAX_KNOWN_APPROVALS = 200;

/** A requester's approve/deny decision on their own pending confirmation. */
export const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().max(500).optional(),
});
export type DecisionBody = z.infer<typeof decisionSchema>;
