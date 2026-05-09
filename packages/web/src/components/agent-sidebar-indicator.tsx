"use client";

import { useChatSession } from "@/components/chat-session-provider";

export function AgentSidebarIndicator({ agentId }: { agentId: string }) {
  const { bundle } = useChatSession(agentId);
  if (!bundle) return null;

  if (bundle.isRunning) {
    return (
      <span
        data-testid="agent-running-indicator"
        aria-label="Agent is responding"
        className="size-1.5 rounded-full bg-primary animate-pulse shrink-0"
      />
    );
  }

  return null;
}
