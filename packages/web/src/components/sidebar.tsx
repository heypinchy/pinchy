"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { ClipboardList, Plus, Settings } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
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

interface Agent {
  id: string;
  name: string;
  model: string;
  isPersonal: boolean;
  tagline: string | null;
  avatarSeed: string | null;
}

interface AppSidebarProps {
  agents: Agent[];
  isAdmin: boolean;
}

export function AppSidebar({ agents, isAdmin }: AppSidebarProps) {
  const pathname = usePathname();
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="px-2 py-3 flex items-center gap-3">
          <Image src="/pinchy-logo.png" alt="Pinchy" width={32} height={34} />
          <span className="font-bold text-lg">Pinchy</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {sortedAgents.map((agent) => {
                const isActive = pathname.startsWith(`/chat/${agent.id}`);
                return (
                  <SidebarMenuItem key={agent.id}>
                    <SidebarMenuButton
                      asChild
                      size="lg"
                      isActive={isActive}
                      className={`transition-colors duration-200 ${
                        isActive
                          ? "data-[active=true]:bg-[oklch(0.92_0.005_60)] data-[active=true]:text-foreground hover:bg-[oklch(0.92_0.005_60)] hover:text-foreground"
                          : ""
                      }`}
                    >
                      <Link href={`/chat/${agent.id}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={getAgentAvatarSvg({
                            avatarSeed: agent.avatarSeed,
                            name: agent.name,
                          })}
                          alt=""
                          className="size-8 rounded-full shrink-0"
                        />
                        <div className="flex flex-col min-w-0">
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
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
            <LogoutButton />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
