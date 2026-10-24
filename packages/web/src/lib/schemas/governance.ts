import { z } from "zod";

/**
 * `PUT /api/settings/governance` — the two member-access switches
 * (Settings → Organization → Member access), always sent together. Shared with
 * the settings card so a renamed field is a compile error, not a runtime 400
 * (AGENTS.md § "Shared Schemas And Typed Client").
 */
export const instancePolicySchema = z
  .object({
    memberPersonalAgents: z.boolean(),
    memberAutomations: z.boolean(),
  })
  .strict();
export type InstancePolicyInput = z.infer<typeof instancePolicySchema>;
