export { AGENT_NAME_MAX_LENGTH } from "@/lib/agent-constants";

import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";
import {
  recalculateTelegramAllowStores,
  clearAllowStoreForAccount,
} from "@/lib/telegram-allow-store";
import { deleteSetting } from "@/lib/settings";

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
    // Clean up Telegram bot settings if this agent had a bot
    await deleteSetting(`telegram_bot_token:${id}`);
    await deleteSetting(`telegram_bot_username:${id}`);
    clearAllowStoreForAccount(id);
    await regenerateOpenClawConfig();
    await recalculateTelegramAllowStores();
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
