import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireAuth } from "@/lib/require-auth";
import { getVisibleAgents } from "@/lib/visible-agents";
import { getInstancePolicy } from "@/lib/instance-policy";
import { AgentsPageContent } from "./agents-page-content";

export const metadata: Metadata = {
  title: "Agents",
};

const MOBILE_UA_PATTERN = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini/i;

export default async function AgentsPage() {
  const session = await requireAuth();
  const userId = session?.user?.id;
  const userRole = session?.user?.role ?? "member";

  const visibleAgents = await getVisibleAgents(userId!, userRole);

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent") ?? "";
  const isMobile = MOBILE_UA_PATTERN.test(userAgent);

  // A member whose personal agent is switched off is sent here from its chat
  // URL. Stay and say why it is gone, instead of jumping on to a shared agent.
  const personalAgentsOff =
    userRole !== "admin" && !(await getInstancePolicy()).memberPersonalAgents;

  if (!isMobile && visibleAgents.length > 0 && !personalAgentsOff) {
    redirect(`/chat/${visibleAgents[0].id}`);
  }

  return <AgentsPageContent agents={visibleAgents} personalAgentsOff={personalAgentsOff} />;
}
