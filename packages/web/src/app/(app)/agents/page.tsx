import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireAuth } from "@/lib/require-auth";
import { getVisibleAgents } from "@/lib/visible-agents";
import { AgentsPageContent } from "./agents-page-content";

const MOBILE_UA_PATTERN = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini/i;

export default async function AgentsPage() {
  const session = await requireAuth();
  const userId = session?.user?.id;
  const userRole = session?.user?.role ?? "member";

  const visibleAgents = await getVisibleAgents(userId!, userRole);

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent") ?? "";
  const isMobile = MOBILE_UA_PATTERN.test(userAgent);

  if (!isMobile && visibleAgents.length > 0) {
    redirect(`/chat/${visibleAgents[0].id}`);
  }

  return <AgentsPageContent agents={visibleAgents} />;
}
