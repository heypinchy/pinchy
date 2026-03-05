import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess } from "@/lib/agent-access";
import { getAgentAvatarSvg } from "@/lib/avatar";

export default async function ChatPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const session = await requireAuth();

  const agent = await db
    .select()
    .from(activeAgents)
    .where(eq(activeAgents.id, agentId))
    .then((rows) => rows[0]);

  if (!agent) notFound();

  try {
    assertAgentAccess(agent, session.user.id!, session.user.role);
  } catch {
    notFound();
  }

  const avatarUrl = getAgentAvatarSvg({ avatarSeed: agent.avatarSeed, name: agent.name });
  const canEdit =
    session.user.role === "admin" || (agent.isPersonal && agent.ownerId === session.user.id);

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
