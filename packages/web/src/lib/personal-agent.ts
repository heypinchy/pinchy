import { db } from "@/db";
import { agents } from "@/db/schema";
import { ensureWorkspace, writeWorkspaceFile } from "@/lib/workspace";
import { getSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";

interface CreateSmithersOptions {
  model: string;
  ownerId: string | null;
  isPersonal: boolean;
}

export async function createSmithersAgent({ model, ownerId, isPersonal }: CreateSmithersOptions) {
  const [agent] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model,
      ownerId,
      isPersonal,
    })
    .returning();

  ensureWorkspace(agent.id);
  writeWorkspaceFile(agent.id, "SOUL.md", SMITHERS_SOUL_MD);

  return agent;
}

export async function seedPersonalAgent(userId: string) {
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const model = defaultProvider
    ? PROVIDERS[defaultProvider].defaultModel
    : "anthropic/claude-sonnet-4-20250514";

  return createSmithersAgent({ model, ownerId: userId, isPersonal: true });
}
