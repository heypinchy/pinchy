import Link from "next/link";
import Image from "next/image";
import { Bot, Plus, Settings } from "lucide-react";
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
}

interface AppSidebarProps {
  agents: Agent[];
}

export function AppSidebar({ agents }: AppSidebarProps) {
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
          {agents.map((agent) => (
            <SidebarMenuItem key={agent.id}>
              <SidebarMenuButton asChild>
                <Link href={`/chat/${agent.id}`}>
                  <Bot className="size-4" />
                  <span>{agent.name}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link href="/agents/new">
                <Plus className="size-4" />
                <span>New Agent</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
