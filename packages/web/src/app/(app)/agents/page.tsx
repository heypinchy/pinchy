import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireAuth } from "@/lib/require-auth";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq, or } from "drizzle-orm";
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

  const visibleAgents = await db
    .select()
    .from(activeAgents)
    .where(or(eq(activeAgents.isPersonal, false), eq(activeAgents.ownerId, userId!)));

  return <AgentsPageContent agents={visibleAgents} />;
}
