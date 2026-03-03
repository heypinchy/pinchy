import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getSetting } from "@/lib/settings";
import { writeWorkspaceFileInternal } from "@/lib/workspace";

export async function syncUserContextToWorkspaces(userId: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  const context = user?.context ?? "";

  const personalAgents = await db.query.agents.findMany({
    where: and(eq(agents.isPersonal, true), eq(agents.ownerId, userId)),
  });

  for (const agent of personalAgents) {
    writeWorkspaceFileInternal(agent.id, "USER.md", context);
  }
}

export async function syncOrgContextToWorkspaces(): Promise<void> {
  const context = (await getSetting("org_context")) ?? "";

  const sharedAgents = await db.query.agents.findMany({
    where: eq(agents.isPersonal, false),
  });

  for (const agent of sharedAgents) {
    writeWorkspaceFileInternal(agent.id, "USER.md", context);
  }
}

export async function getContextForAgent(agent: {
  isPersonal: boolean;
  ownerId: string | null;
}): Promise<string> {
  if (agent.isPersonal && agent.ownerId) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, agent.ownerId),
    });
    return user?.context ?? "";
  }

  return (await getSetting("org_context")) ?? "";
}
