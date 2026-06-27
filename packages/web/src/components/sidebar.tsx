"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
import { getLastChat, subscribeLastChat } from "@/lib/last-chat-store";
import { BarChart3, Bug, ClipboardList, Plus, Settings } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import { useAgentsContext } from "@/components/agents-provider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { getAgentAvatarSvg } from "@/lib/avatar";
import { buildBugReportUrl } from "@/lib/github-issue";
import { AgentSidebarIndicator } from "@/components/agent-sidebar-indicator";
import { useIntegrationHealth } from "@/hooks/use-integration-health";

interface AppSidebarProps {
  isAdmin: boolean;
}

// Refresh the resolved agent links on BOTH change sources: a cross-tab write
// fires the `storage` event, while a same-tab write (the common case — the open
// chat recording itself) fires no `storage` event and is delivered via the
// store's own in-module notifier. Relying on navigation re-renders alone left
// the link one render behind the write, so it reopened an older chat (#508).
function subscribeLastChats(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  const unsubscribeSameTab = subscribeLastChat(callback);
  return () => {
    window.removeEventListener("storage", callback);
    unsubscribeSameTab();
  };
}

export function AppSidebar({ isAdmin }: AppSidebarProps) {
  const pathname = usePathname();
  const { sortedAgents } = useAgentsContext();
  const { authFailedCount } = useIntegrationHealth(isAdmin);

  // Resolve each agent's link to the chat last viewed on THIS device (#508), so
  // clicking an agent returns the user where they left off instead of the oldest
  // chat. Read via useSyncExternalStore (not an effect) so the server snapshot is
  // empty — links fall back to the bare /chat/<agentId>, where the server resolves
  // the most-recent chat — and the client reads localStorage without a hydration
  // mismatch or a synchronous setState. The snapshot is a JSON string so its
  // identity stays stable (Object.is) between renders when nothing changed.
  const agentIds = sortedAgents.map((a) => a.id);
  const serializedLastChats = useSyncExternalStore(
    subscribeLastChats,
    () => {
      const map: Record<string, string> = {};
      for (const id of agentIds) {
        const last = getLastChat(id);
        if (last) map[id] = last;
      }
      return JSON.stringify(map);
    },
    () => "{}"
  );
  const lastChatById = useMemo(
    () => JSON.parse(serializedLastChats) as Record<string, string>,
    [serializedLastChats]
  );

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="px-2 py-3 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/pinchy-logo.svg" alt="Pinchy" width={32} height={34} />
          <span className="font-bold text-lg">Pinchy</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {sortedAgents.map((agent) => {
                const isActive = pathname.startsWith(`/chat/${agent.id}`);
                const lastChat = lastChatById[agent.id];
                const href = lastChat ? `/chat/${agent.id}/${lastChat}` : `/chat/${agent.id}`;
                return (
                  <SidebarMenuItem key={agent.id}>
                    <SidebarMenuButton
                      asChild
                      size="lg"
                      isActive={isActive}
                      className={`transition-colors duration-200 ${
                        isActive
                          ? "data-[active=true]:bg-[oklch(0.92_0.005_60)] data-[active=true]:text-foreground hover:bg-[oklch(0.92_0.005_60)] hover:text-foreground dark:data-[active=true]:bg-[oklch(0.30_0.005_60)] dark:data-[active=true]:text-foreground dark:hover:bg-[oklch(0.30_0.005_60)] dark:hover:text-foreground"
                          : ""
                      }`}
                    >
                      <Link href={href}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={getAgentAvatarSvg({
                            avatarSeed: agent.avatarSeed,
                            name: agent.name,
                          })}
                          alt=""
                          className="size-9 rounded-full shrink-0"
                        />
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="truncate font-semibold" title={agent.name}>
                            {agent.name}
                          </span>
                          {agent.tagline && (
                            <span
                              className={`text-xs truncate ${isActive ? "text-muted-foreground" : "text-muted-foreground/70"}`}
                              title={agent.tagline}
                            >
                              {agent.tagline}
                            </span>
                          )}
                        </div>
                        <AgentSidebarIndicator agentId={agent.id} />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {isAdmin && (
          <div className="px-3">
            <Button variant="outline" size="sm" className="w-full justify-start gap-2" asChild>
              <Link href="/agents/new">
                <Plus className="size-4" />
                New Agent
              </Link>
            </Button>
          </div>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link href="/settings">
                <Settings className="size-4" />
                <span>Settings</span>
                {authFailedCount > 0 && (
                  <span
                    aria-label={`${authFailedCount} integration${authFailedCount === 1 ? "" : "s"} need${authFailedCount === 1 ? "s" : ""} attention`}
                    className="ml-auto flex items-center justify-center size-4 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold"
                  >
                    !
                  </span>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/usage">
                  <BarChart3 className="size-4" />
                  <span>Usage</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/audit">
                  <ClipboardList className="size-4" />
                  <span>Audit Trail</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() =>
                window.open(buildBugReportUrl(pathname), "_blank", "noopener,noreferrer")
              }
            >
              <Bug className="size-4" />
              <span>Report a bug</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <LogoutButton />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
