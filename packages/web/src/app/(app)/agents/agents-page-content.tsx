"use client";

import { usePathname } from "next/navigation";
import { AgentList, type Agent } from "@/components/agent-list";

interface AgentsPageContentProps {
  agents: Agent[];
}

export function AgentsPageContent({ agents }: AgentsPageContentProps) {
  const currentPath = usePathname();

  return (
    <div className="p-4 md:p-8">
      <h1 className="text-2xl font-bold mb-4">Agents</h1>
      <AgentList agents={agents} currentPath={currentPath} />
    </div>
  );
}
