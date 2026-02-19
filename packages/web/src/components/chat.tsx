"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { useWsRuntime } from "@/hooks/use-ws-runtime";

interface ChatProps {
  agentId: string;
  agentName: string;
  configuring?: boolean;
}

export function Chat({ agentId, agentName, configuring = false }: ChatProps) {
  const { runtime, isConnected } = useWsRuntime(agentId);

  const statusMessage = !isConnected
    ? configuring
      ? "Applying your changes \u2014 this takes a moment..."
      : "Disconnected"
    : "Connected";

  const statusColor = isConnected ? "text-green-600" : "text-destructive";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-col h-full">
        <header className="p-4 border-b flex items-center justify-between">
          <h1 className="font-bold">{agentName}</h1>
          <span className={`text-xs ${statusColor}`}>{statusMessage}</span>
        </header>
        <div className="flex-1">
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
