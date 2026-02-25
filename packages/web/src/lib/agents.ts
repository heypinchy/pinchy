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
}

export async function deleteAgent(id: string) {
  const [deleted] = await db.delete(agents).where(eq(agents.id, id)).returning();

  if (deleted) {
    deleteWorkspace(id);
    await regenerateOpenClawConfig();
  }

  return deleted;
}

export async function updateAgent(id: string, data: UpdateAgentInput) {
  const [updated] = await db.update(agents).set(data).where(eq(agents.id, id)).returning();

  await regenerateOpenClawConfig();

  return updated;
}
