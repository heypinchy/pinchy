import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { writeWorkspaceFileInternal } from "@/lib/workspace";
import { getOnboardingPrompt } from "@/lib/onboarding-prompt";

export async function migrateExistingSmithers(): Promise<void> {
  const personalAgents = await db.query.agents.findMany({
    where: eq(agents.isPersonal, true),
  });

  // Single batched owner lookup instead of one findFirst per agent.
  const ownerIds = [...new Set(personalAgents.map((a) => a.ownerId).filter((id) => id !== null))];
  const owners =
    ownerIds.length > 0
      ? await db.query.users.findMany({ where: inArray(users.id, ownerIds) })
      : [];
  const ownerById = new Map(owners.map((u) => [u.id, u]));

  for (const agent of personalAgents) {
    if (!agent.ownerId) continue;

    const user = ownerById.get(agent.ownerId);

    if (!user || user.context !== null) continue;

    const isAdmin = user.role === "admin";
    // docs_list / docs_read come from the pinchy-docs plugin, which is enabled
    // automatically for every personal agent (see openclaw-config.ts). No need
    // to list them here.
    const allowedTools = isAdmin
      ? ["pinchy_save_user_context", "pinchy_save_org_context"]
      : ["pinchy_save_user_context"];

    await db.update(agents).set({ allowedTools }).where(eq(agents.id, agent.id));

    writeWorkspaceFileInternal(agent.id, "USER.md", getOnboardingPrompt(isAdmin));
  }
}
