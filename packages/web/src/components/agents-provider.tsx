"use client";

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAgents } from "@/hooks/use-agents";
import { sortAgents } from "@/components/agent-list";
import type { Agent } from "@/components/agent-list";

interface AgentsContextValue {
  agents: Agent[];
  sortedAgents: Agent[];
  getAgent: (id: string) => Agent | undefined;
}

const AgentsContext = createContext<AgentsContextValue | null>(null);

export function useAgentsContext(): AgentsContextValue {
  const ctx = useContext(AgentsContext);
  if (!ctx) throw new Error("useAgentsContext must be used within AgentsProvider");
  return ctx;
}

function useAccessGuard(agents: Agent[], sortedAgents: Agent[]) {
  const pathname = usePathname();
  const router = useRouter();
  const lastRedirectedFrom = useRef<string | null>(null);

  useEffect(() => {
    const chatMatch = pathname.match(/^\/chat\/([^/]+)/);
    if (!chatMatch) {
      lastRedirectedFrom.current = null;
      return;
    }

    const currentAgentId = chatMatch[1];
    if (agents.some((a) => a.id === currentAgentId)) {
      lastRedirectedFrom.current = null;
      return;
    }

    if (agents.length === 0) return;
    if (lastRedirectedFrom.current === currentAgentId) return;

    lastRedirectedFrom.current = currentAgentId;
    toast("You no longer have access to this agent", { id: "agent-access-lost" });
    router.push(`/chat/${sortedAgents[0].id}`);
  }, [agents, sortedAgents, pathname, router]);
}

export function AgentsProvider({
  initialAgents,
  children,
}: {
  initialAgents: Agent[];
  children: React.ReactNode;
}) {
  const agents = useAgents(initialAgents);
  const sortedAgents = useMemo(() => sortAgents(agents), [agents]);
  const getAgent = useMemo(() => (id: string) => agents.find((a) => a.id === id), [agents]);

  useAccessGuard(agents, sortedAgents);

  const value = useMemo(
    () => ({ agents, sortedAgents, getAgent }),
    [agents, sortedAgents, getAgent]
  );

  return <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>;
}
