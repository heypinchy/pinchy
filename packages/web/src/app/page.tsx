import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { requireAuth } from "@/lib/require-auth";
import { getVisibleAgents } from "@/lib/visible-agents";

export const dynamic = "force-dynamic";

const MOBILE_UA_PATTERN = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini/i;

export default async function Home() {
  const setupComplete = await isSetupComplete();

  if (!setupComplete) {
    redirect("/setup");
  }

  const session = await requireAuth();

  const providerConfigured = await isProviderConfigured();
  if (!providerConfigured) {
    redirect("/setup/provider");
  }

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent") ?? "";
  const isMobile = MOBILE_UA_PATTERN.test(userAgent);

  if (!isMobile) {
    const userId = session?.user?.id;
    const userRole = session?.user?.role ?? "member";
    const visibleAgents = await getVisibleAgents(userId!, userRole);
    if (visibleAgents.length > 0) {
      redirect(`/chat/${visibleAgents[0].id}`);
    }
  }

  redirect("/agents");
}
