"use client";

import { useAgentActivity } from "@/components/chat-session-provider";

export function AgentSidebarIndicator({ agentId }: { agentId: string }) {
  // Reflect activity across ANY of the agent's sessions, not just the default
  // one — a run started in a non-default chat must still light the sidebar.
  const { isRunning, lastError } = useAgentActivity(agentId);

  // Error wins over running: a stale error shouldn't be hidden by a
  // freshly-started retry. The only sidebar error is reconnect exhaustion;
  // it clears once the connection is re-established.
  if (lastError) {
    return (
      <span
        data-testid="agent-error-indicator"
        aria-label="Agent error"
        title={lastError}
        className="size-1.5 rounded-full bg-destructive shrink-0"
      />
    );
  }

  if (isRunning) {
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
