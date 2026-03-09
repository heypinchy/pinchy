import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireAuth } from "@/lib/require-auth";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { getVisibleAgents } from "@/lib/visible-agents";
import { AgentsPageContent } from "./agents-page-content";

const MOBILE_UA_PATTERN = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini/i;

export default async function AgentsPage() {
  const session = await requireAuth();
  const userId = session?.user?.id;

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent") ?? "";
  const isMobile = MOBILE_UA_PATTERN.test(userAgent);

  if (!isMobile) {
    const [firstAgent] = await db.select({ id: activeAgents.id }).from(activeAgents).limit(1);
    if (firstAgent) {
      redirect(`/chat/${firstAgent.id}`);
    }
  }

  const visibleAgents = await getVisibleAgents(userId!, session?.user?.role ?? "member");

  return <AgentsPageContent agents={visibleAgents} />;
}
