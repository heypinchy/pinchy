"use client";

import { useChatSession } from "@/components/chat-session-provider";

export function AgentSidebarIndicator({ agentId }: { agentId: string }) {
  const { bundle } = useChatSession(agentId);
  if (!bundle) return null;

  // Error wins over running: a stale error shouldn't be hidden by a
  // freshly-started retry. Error clears when the user opens the chat
  // and useWsRuntime resets isOrphaned.
  if (bundle.lastError) {
    return (
      <span
        data-testid="agent-error-indicator"
        aria-label={bundle.lastError}
        title={bundle.lastError}
        className="size-1.5 rounded-full bg-destructive shrink-0"
      />
    );
  }

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
