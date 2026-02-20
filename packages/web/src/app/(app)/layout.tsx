import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireAuth } from "@/lib/require-auth";
import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AppSidebar } from "@/components/sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await cookies();

  const setupComplete = await isSetupComplete();
  if (!setupComplete) redirect("/setup");

  const session = await requireAuth();

  const providerConfigured = await isProviderConfigured();
  if (!providerConfigured) redirect("/setup/provider");

  const allAgents = await db.select().from(agents);
  const isAdmin = session?.user?.role === "admin";

  return (
    <SidebarProvider>
      <AppSidebar agents={allAgents} isAdmin={isAdmin} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
