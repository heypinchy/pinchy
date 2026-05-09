import { db } from "@/db";
import { agents } from "@/db/schema";
import {
  ensureWorkspace,
  writeWorkspaceFile,
  writeWorkspaceFileInternal,
  writeIdentityFile,
} from "@/lib/workspace";
import { getContextForAgent } from "@/lib/context-sync";
import { getSetting } from "@/lib/settings";
import { type ProviderName } from "@/lib/providers";
import { getDefaultModel } from "@/lib/provider-models";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";
import { getOnboardingPrompt, ONBOARDING_GREETING } from "@/lib/onboarding-prompt";

interface CreateSmithersOptions {
  model: string;
  ownerId: string | null;
  isPersonal: boolean;
  isAdmin?: boolean;
}

export async function createSmithersAgent({
  model,
  ownerId,
  isPersonal,
  isAdmin = false,
}: CreateSmithersOptions) {
  // docs_list / docs_read come from the pinchy-docs plugin, which is enabled
  // automatically for every personal agent (see openclaw-config.ts). No need
  // to list them here.
  const baseTools = isAdmin
    ? ["pinchy_save_user_context", "pinchy_save_org_context"]
    : ["pinchy_save_user_context"];
  // pinchy_ls / pinchy_read let Smithers read files the user uploaded into
  // the agent workspace (uploads/). This is the path the chat composer's
  // PDF/audio support relies on — without it, the upload hint mentions a file
  // the agent cannot reach. Scoped to "uploads" via pluginConfig below.
  const allowedTools = [...baseTools, "pinchy_ls", "pinchy_read"];

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
      greetingMessage: ONBOARDING_GREETING,
      allowedTools,
      pluginConfig: {
        "pinchy-files": { allowed_paths: ["uploads"] },
      },
    })
    .returning();

  ensureWorkspace(agent.id);
  writeWorkspaceFile(agent.id, "SOUL.md", SMITHERS_SOUL_MD);
  writeIdentityFile(agent.id, { name: agent.name, tagline: agent.tagline });

  const context = await getContextForAgent({
    isPersonal: agent.isPersonal,
    ownerId: agent.ownerId,
  });

  // Write onboarding prompt to USER.md if user has no context yet.
  // OpenClaw reads USER.md as part of the agent's system prompt, so putting
  // onboarding instructions there ensures Smithers sees them.
  writeWorkspaceFileInternal(agent.id, "USER.md", context || getOnboardingPrompt(isAdmin));

  return agent;
}

export async function seedPersonalAgent(userId: string, isAdmin = false) {
  const existing = await db.query.agents.findFirst({
    where: (a, { and, eq }) => and(eq(a.ownerId, userId), eq(a.isPersonal, true)),
  });
  if (existing) return existing;

  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const model = defaultProvider
    ? await getDefaultModel(defaultProvider)
    : "anthropic/claude-sonnet-4-6";

  return createSmithersAgent({ model, ownerId: userId, isPersonal: true, isAdmin });
}
