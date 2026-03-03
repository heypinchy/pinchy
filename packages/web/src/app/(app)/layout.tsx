import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireAuth } from "@/lib/require-auth";
import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq, or } from "drizzle-orm";
import { AppSidebar } from "@/components/sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await cookies();

  const setupComplete = await isSetupComplete();
  if (!setupComplete) redirect("/setup");

  const session = await requireAuth();

  const providerConfigured = await isProviderConfigured();
  if (!providerConfigured) redirect("/setup/provider");

  const userId = session?.user?.id;
  const visibleAgents = await db
    .select()
    .from(activeAgents)
    .where(or(eq(activeAgents.isPersonal, false), eq(activeAgents.ownerId, userId!)));
  const isAdmin = session?.user?.role === "admin";

  return (
    <SidebarProvider>
      <AppSidebar agents={visibleAgents} isAdmin={isAdmin} />
      <SidebarInset className="overflow-y-auto">{children}</SidebarInset>
    </SidebarProvider>
  );
}
