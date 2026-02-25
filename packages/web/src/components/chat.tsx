"use client";

import { createContext } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { useWsRuntime } from "@/hooks/use-ws-runtime";
import Link from "next/link";
import { Settings, MessageSquarePlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export const AgentAvatarContext = createContext<string | null>(null);
export const AgentIdContext = createContext<string | null>(null);

interface ChatProps {
  agentId: string;
  agentName: string;
  configuring?: boolean;
  isPersonal?: boolean;
  avatarUrl?: string;
}

export function Chat({
  agentId,
  agentName,
  configuring = false,
  isPersonal = false,
  avatarUrl,
}: ChatProps) {
  const { runtime, isConnected, isDelayed, isHistoryLoaded } = useWsRuntime(agentId);

  const statusMessage = !isConnected
    ? configuring
      ? "Applying your changes \u2014 this takes a moment..."
      : "Disconnected"
    : "Connected";

  const statusColor = isConnected ? "text-green-600" : "text-destructive";

  function handleNewChat() {
    window.location.reload();
  }

  return (
    <AgentIdContext.Provider value={agentId}>
      <AssistantRuntimeProvider runtime={runtime}>
        <AgentAvatarContext.Provider value={avatarUrl ?? null}>
          <div className="flex flex-col h-full min-h-0">
            <header className="p-4 border-b flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 animate-in fade-in duration-300">
                {avatarUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" className="size-7 rounded-full" />
                )}
                <h1 className="font-bold">{agentName}</h1>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="text-xs font-normal">
                        {isPersonal ? "Private" : "Shared"}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isPersonal
                        ? "Your conversations are private and not shared with anyone."
                        : "Your conversations help build team knowledge that's available to all team members."}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleNewChat}
                  aria-label="New Chat"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <MessageSquarePlus className="h-5 w-5" />
                </button>
                <Link
                  href={`/chat/${agentId}/settings`}
                  aria-label="Settings"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Settings className="h-5 w-5" />
                </Link>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={`size-2 rounded-full shrink-0 ${isConnected ? "bg-green-600" : "bg-destructive"}`}
                        aria-label={statusMessage}
                      />
                    </TooltipTrigger>
                    <TooltipContent>{statusMessage}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </header>
            <div className="flex-1 min-h-0 animate-in fade-in duration-300">
              <Thread isHistoryLoaded={isHistoryLoaded} />
            </div>
            {isDelayed && (
              <div className="px-4 py-2 text-center text-xs text-muted-foreground border-t">
                The agent is taking longer than usual. This may be due to high demand.
              </div>
            )}
          </div>
        </AgentAvatarContext.Provider>
      </AssistantRuntimeProvider>
    </AgentIdContext.Provider>
  );
}
