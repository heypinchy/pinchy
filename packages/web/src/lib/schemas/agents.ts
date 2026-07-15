import { z } from "zod";
import { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";
import { pluginConfigSchema } from "@/lib/domain-validation";

/**
 * Request schema for creating an agent. Shared between the session-authenticated
 * POST /api/agents route and the future key-authenticated POST /api/v1/agents
 * route (#572) so both validate identical input.
 */
export const createAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .refine((v) => v.trim().length > 0, "Name is required"),
  templateId: z.string().min(1),
  tagline: z.string().nullish(),
  pluginConfig: pluginConfigSchema.nullish(),
  connectionId: z.string().nullish(),
  defaultAllowedTools: z.array(z.string()).optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
