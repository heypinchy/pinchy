import Link from "next/link";
import Image from "next/image";
import { ClipboardList, Plus, Settings } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
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
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;
    return 0;
  });

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="p-4 flex items-center gap-2">
          <Image src="/pinchy-logo.png" alt="Pinchy" width={28} height={30} />
          <span className="font-bold text-lg">Pinchy</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarMenu>
          {sortedAgents.map((agent) => (
            <SidebarMenuItem key={agent.id}>
              <SidebarMenuButton asChild>
                <Link href={`/chat/${agent.id}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={getAgentAvatarSvg({ avatarSeed: agent.avatarSeed, name: agent.name })}
                    alt=""
                    className="size-6 rounded-full shrink-0"
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{agent.name}</span>
                    {agent.tagline && (
                      <span className="text-xs text-muted-foreground/70 truncate">
                        {agent.tagline}
                      </span>
                    )}
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/agents/new">
                  <Plus className="size-4" />
                  <span>New Agent</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
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
