import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { writeWorkspaceFileInternal } from "@/lib/workspace";
import { getOnboardingPrompt } from "@/lib/onboarding-prompt";

export async function migrateExistingSmithers(): Promise<void> {
  const personalAgents = await db.query.agents.findMany({
    where: eq(agents.isPersonal, true),
  });

  for (const agent of personalAgents) {
    if (!agent.ownerId) continue;

    const user = await db.query.users.findFirst({
      where: eq(users.id, agent.ownerId),
    });

    if (!user || user.context !== null) continue;

    const isAdmin = user.role === "admin";
    const allowedTools = isAdmin
      ? ["pinchy_save_user_context", "pinchy_save_org_context"]
      : ["pinchy_save_user_context"];

    await db.update(agents).set({ allowedTools }).where(eq(agents.id, agent.id));

    writeWorkspaceFileInternal(agent.id, "ONBOARDING.md", getOnboardingPrompt(isAdmin));
  }
}
