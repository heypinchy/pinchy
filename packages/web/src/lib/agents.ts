export { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";

import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";

export interface UpdateAgentInput {
  name?: string;
  model?: string;
  allowedTools?: string[];
  pluginConfig?: unknown;
  greetingMessage?: string | null;
  tagline?: string | null;
  avatarSeed?: string | null;
  personalityPresetId?: string | null;
  visibility?: string;
}

export async function deleteAgent(id: string) {
  const [updated] = await db
    .update(agents)
    .set({ deletedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();

  if (updated) {
    deleteWorkspace(id);
    await regenerateOpenClawConfig();
  }

  return updated;
}

const OPENCLAW_CONFIG_FIELDS: (keyof UpdateAgentInput)[] = [
  "name",
  "model",
  "allowedTools",
  "pluginConfig",
];

export async function updateAgent(id: string, data: UpdateAgentInput) {
  const [updated] = await db.update(agents).set(data).where(eq(agents.id, id)).returning();

  const touchesOpenClawConfig = OPENCLAW_CONFIG_FIELDS.some((field) => field in data);
  if (touchesOpenClawConfig) {
    await regenerateOpenClawConfig();
  }

  return updated;
}
