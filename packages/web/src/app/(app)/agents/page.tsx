import { requireAuth } from "@/lib/require-auth";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq, or } from "drizzle-orm";
import { AgentsPageContent } from "./agents-page-content";

export default async function AgentsPage() {
  const session = await requireAuth();

  const isAdmin = session?.user?.role === "admin";
  const userId = session?.user?.id;

  const visibleAgents = isAdmin
    ? await db.select().from(activeAgents)
    : await db
        .select()
        .from(activeAgents)
        .where(or(eq(activeAgents.isPersonal, false), eq(activeAgents.ownerId, userId!)));

  return <AgentsPageContent agents={visibleAgents} />;
}
