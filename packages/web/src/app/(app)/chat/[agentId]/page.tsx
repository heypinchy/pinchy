import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { isEnterprise } from "@/lib/enterprise";
import { getAgentAvatarSvg } from "@/lib/avatar";

export default async function ChatPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const session = await requireAuth();
  const userId = session.user.id!;
  const userRole = session.user.role;

  const agent = await db
    .select()
    .from(activeAgents)
    .where(eq(activeAgents.id, agentId))
    .then((rows) => rows[0]);

  if (!agent) notFound();

  const enterprise = await isEnterprise();
  const effVis = effectiveVisibility(agent.visibility, enterprise);
  const needsGroups = userRole !== "admin" && effVis === "restricted";

  const [userGroupIds, agentGroupIds] = await Promise.all([
    needsGroups ? getUserGroupIds(userId) : Promise.resolve([]),
    needsGroups ? getAgentGroupIds(agentId) : Promise.resolve([]),
  ]);

  try {
    assertAgentAccess(agent, userId, userRole, userGroupIds, agentGroupIds, enterprise);
  } catch {
    notFound();
  }

  const avatarUrl = getAgentAvatarSvg({ avatarSeed: agent.avatarSeed, name: agent.name });
  const canEdit = userRole === "admin" || (agent.isPersonal && agent.ownerId === userId);

  return (
    <Chat
      key={agent.id}
      agentId={agent.id}
      agentName={agent.name}
      isPersonal={agent.isPersonal}
      avatarUrl={avatarUrl}
      canEdit={canEdit}
    />
  );
}
