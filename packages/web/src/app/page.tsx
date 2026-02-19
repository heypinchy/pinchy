import { redirect } from "next/navigation";
import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { requireAuth } from "@/lib/require-auth";
import { db } from "@/db";
import { agents } from "@/db/schema";

export const dynamic = "force-dynamic";

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

  const allAgents = await db.select().from(agents);

  if (allAgents.length > 0) {
    redirect(`/chat/${allAgents[0].id}`);
  }

  return <div className="p-8">No agent configured.</div>;
}
