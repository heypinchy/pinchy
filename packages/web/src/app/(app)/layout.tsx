import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireAuth } from "@/lib/require-auth";
import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { getVisibleAgents } from "@/lib/visible-agents";
import { AppSidebar } from "@/components/sidebar";
import { AppShell } from "@/components/app-shell";
import { AgentsProvider } from "@/components/agents-provider";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { EnterpriseBanner } from "@/components/enterprise-banner";
import { InsecureBanner } from "@/components/insecure-banner";
import { DevToolbar } from "@/components/dev-toolbar";
import { ChatSessionProvider } from "@/components/chat-session-provider";
import { ChatSessionMounts } from "@/components/chat-session-mounts";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await cookies();

  const setupComplete = await isSetupComplete();
  if (!setupComplete) redirect("/setup");

  const session = await requireAuth();

  const providerConfigured = await isProviderConfigured();
  if (!providerConfigured) redirect("/setup/provider");

  const userId = session?.user?.id;
  const visibleAgents = await getVisibleAgents(userId!, session?.user?.role ?? "member");
  const isAdmin = session?.user?.role === "admin";

  return (
    <AgentsProvider initialAgents={visibleAgents}>
      <ChatSessionProvider>
        <SidebarProvider>
          <AppSidebar isAdmin={isAdmin} />
          <SidebarInset className="h-dvh overflow-hidden">
            <InsecureBanner isAdmin={isAdmin} />
            <EnterpriseBanner isAdmin={isAdmin} />
            <AppShell isAdmin={isAdmin}>{children}</AppShell>
          </SidebarInset>
        </SidebarProvider>
        <ChatSessionMounts />
        {process.env.NODE_ENV === "development" && <DevToolbar />}
      </ChatSessionProvider>
    </AgentsProvider>
  );
}
