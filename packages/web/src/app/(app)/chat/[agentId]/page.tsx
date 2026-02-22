import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess } from "@/lib/agent-access";

export default async function ChatPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const session = await requireAuth();

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent) notFound();

  try {
    assertAgentAccess(agent, session.user.id!, session.user.role);
  } catch {
    notFound();
  }

  return <Chat agentId={agent.id} agentName={agent.name} isPersonal={agent.isPersonal} />;
}
