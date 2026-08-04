import { z } from "zod";
import { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";
import { pluginConfigSchema } from "@/lib/domain-validation";
import { starterPromptsSchema } from "@/lib/schemas/starter-prompts";
import { AGENT_VISIBILITIES } from "@/db/enums";

/**
 * Request schema for creating an agent. Shared between the session-authenticated
 * POST /api/agents route and the key-authenticated POST /api/v1/agents route
 * (#572) so both validate identical input.
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

/**
 * Request schema for `PATCH /api/agents/[agentId]`. Shared with
 * `agent-settings-page-content.tsx`, which builds one unified patch body out
 * of whichever settings tabs are dirty — the case where an untyped
 * `Record<string, unknown>` hid a rename until a runtime 400.
 */
export const updateAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .refine((v) => v.trim().length > 0, "Name is required")
    .optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  pluginConfig: pluginConfigSchema.nullable().optional(),
  greetingMessage: z.string().min(1, "Greeting message cannot be empty").optional(),
  tagline: z.string().nullable().optional(),
  starterPrompts: starterPromptsSchema.optional(),
  avatarSeed: z.string().nullable().optional(),
  personalityPresetId: z.string().nullable().optional(),
  visibility: z.enum(AGENT_VISIBILITIES).optional(),
  groupIds: z.array(z.string()).optional(),
});
export type UpdateAgentInput = z.input<typeof updateAgentSchema>;

/** `PUT /api/agents/[agentId]/files/[filename]` — a workspace text file. */
export const writeAgentFileSchema = z.object({ content: z.string() });
export type WriteAgentFileInput = z.infer<typeof writeAgentFileSchema>;
