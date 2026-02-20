import Link from "next/link";
import Image from "next/image";
import { Bot, Plus, Settings, User } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";

interface Agent {
  id: string;
  name: string;
  model: string;
  isPersonal: boolean;
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
                  {agent.isPersonal ? <User className="size-4" /> : <Bot className="size-4" />}
                  <span>{agent.name}</span>
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
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
