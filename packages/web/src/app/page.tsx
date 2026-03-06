import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { requireAuth } from "@/lib/require-auth";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";

export const dynamic = "force-dynamic";

const MOBILE_UA_PATTERN = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini/i;

export default async function Home() {
  const setupComplete = await isSetupComplete();

  if (!setupComplete) {
    redirect("/setup");
  }

  await requireAuth();

  const providerConfigured = await isProviderConfigured();
  if (!providerConfigured) {
    redirect("/setup/provider");
  }

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent") ?? "";
  const isMobile = MOBILE_UA_PATTERN.test(userAgent);

  if (!isMobile) {
    const [firstAgent] = await db.select({ id: activeAgents.id }).from(activeAgents).limit(1);
    if (firstAgent) {
      redirect(`/chat/${firstAgent.id}`);
    }
  }

  redirect("/agents");
}
