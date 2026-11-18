"use client";

import { usePathname } from "next/navigation";
import { AgentList, type Agent } from "@/components/agent-list";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface AgentsPageContentProps {
  agents: Agent[];
  /** The admin has switched members' personal agents off (Settings → Organization). */
  personalAgentsOff?: boolean;
}

export function AgentsPageContent({ agents, personalAgentsOff = false }: AgentsPageContentProps) {
  const currentPath = usePathname();

  return (
    <div className="p-4 md:p-8">
      <h1 className="text-2xl font-bold mb-4">Agents</h1>
      {personalAgentsOff && (
        <Alert className="mb-4">
          <AlertDescription>
            Your admin has turned off personal agents, so Smithers isn&apos;t available right now.
            Your chats with it are kept and come back if it&apos;s turned on again.
            {agents.length > 0
              ? " The shared agents below work as usual."
              : " Ask your admin for access to a shared agent."}
          </AlertDescription>
        </Alert>
      )}
      <AgentList agents={agents} currentPath={currentPath} />
    </div>
  );
}
