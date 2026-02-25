import { db } from "@/db";
import { agents } from "@/db/schema";
import { ensureWorkspace, writeWorkspaceFile, writeIdentityFile } from "@/lib/workspace";
import { getSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";
import { PERSONALITY_PRESETS, resolveGreetingMessage } from "@/lib/personality-presets";

interface CreateSmithersOptions {
  model: string;
  ownerId: string | null;
  isPersonal: boolean;
}

export async function createSmithersAgent({ model, ownerId, isPersonal }: CreateSmithersOptions) {
  const preset = PERSONALITY_PRESETS["the-butler"];

  const [agent] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model,
      ownerId,
      isPersonal,
      tagline: "Your reliable personal assistant",
      avatarSeed: "__smithers__",
      personalityPresetId: "the-butler",
      greetingMessage: resolveGreetingMessage(preset.greetingMessage, "Smithers"),
    })
    .returning();

  ensureWorkspace(agent.id);
  writeWorkspaceFile(agent.id, "SOUL.md", SMITHERS_SOUL_MD);
  writeIdentityFile(agent.id, { name: agent.name, tagline: agent.tagline });

  return agent;
}

export async function seedPersonalAgent(userId: string) {
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const model = defaultProvider
    ? PROVIDERS[defaultProvider].defaultModel
    : "anthropic/claude-sonnet-4-20250514";

  return createSmithersAgent({ model, ownerId: userId, isPersonal: true });
}
