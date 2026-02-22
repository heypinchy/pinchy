"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { useWsRuntime } from "@/hooks/use-ws-runtime";
import Link from "next/link";
import { Settings, MessageSquarePlus } from "lucide-react";

interface ChatProps {
  agentId: string;
  agentName: string;
  configuring?: boolean;
  isPersonal?: boolean;
}

export function Chat({ agentId, agentName, configuring = false, isPersonal = false }: ChatProps) {
  const { runtime, isConnected } = useWsRuntime(agentId);

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
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-col h-full min-h-0">
        <header className="p-4 border-b flex items-center justify-between shrink-0">
          <h1 className="font-bold">{agentName}</h1>
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
            <span className={`text-xs ${statusColor}`}>{statusMessage}</span>
          </div>
        </header>
        <div className="flex-1 min-h-0">
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
