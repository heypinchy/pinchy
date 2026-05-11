"use client";

import { createContext, useEffect } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { useChatSession } from "@/components/chat-session-provider";
import { useAgentsContext } from "@/components/agents-provider";
import { getAgentAvatarSvg } from "@/lib/avatar";
import Link from "next/link";
import { Settings } from "lucide-react";
import { MobileChatHeader } from "@/components/mobile-chat-header";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type ChatStatus, useChatStatus } from "@/hooks/use-chat-status";

function getStatusIndicator(status: ChatStatus): { colorClass: string; label: string } {
  switch (status.kind) {
    case "ready":
      return { colorClass: "bg-green-600", label: "Connected" };
    case "responding":
      return { colorClass: "bg-green-600", label: "Responding..." };
    case "starting":
      return { colorClass: "bg-yellow-500", label: "Starting..." };
    case "payloadRejected":
      return { colorClass: "bg-destructive", label: "Image too large" };
    case "unavailable":
      switch (status.reason) {
        case "configuring":
          return { colorClass: "bg-yellow-500", label: "Applying changes..." };
        case "disconnected":
          return { colorClass: "bg-destructive", label: "Reconnecting..." };
        case "exhausted":
          return { colorClass: "bg-destructive", label: "Please reload the page" };
        default: {
          const _: never = status.reason;
          return { colorClass: "bg-destructive", label: "Unknown" };
        }
      }
    default: {
      const _: never = status;
      return { colorClass: "bg-destructive", label: "Unknown" };
    }
  }
}

export const AgentAvatarContext = createContext<string | null>(null);
export const AgentIdContext = createContext<string | null>(null);
export const RetryResendContext = createContext<(messageId: string) => void>(() => {});
export const RetryContinueContext = createContext<
  (reason: "orphan" | "partial_stream_failure" | "send_failure") => void
>(() => {});

/**
 * Structured chat connection/activity status derived from the RuntimeBundle.
 * Drives the connection indicator, the retry-button enabled state, and the
 * composer input/send disabled state — one mental model for the user:
 * red dot ⇔ retry disabled.
 */
export const ChatStatusContext = createContext<ChatStatus>({ kind: "starting" });

interface ChatStatusBannerProps {
  status: ChatStatus;
  isDelayed: boolean;
}

function ChatStatusBanner({ status, isDelayed }: ChatStatusBannerProps) {
  if (status.kind === "responding" && isDelayed) {
    return (
      <div className="px-4 py-2 text-center text-xs text-muted-foreground border-t">
        The agent is taking longer than usual. This may be due to high demand.
      </div>
    );
  }
  if (status.kind === "unavailable" && status.reason === "exhausted") {
    return (
      <div className="px-4 py-2 text-center text-xs text-destructive border-t bg-destructive/5">
        Unable to reconnect. Please reload the page to resume chatting.
      </div>
    );
  }
  if (status.kind === "unavailable" && status.reason === "configuring") {
    return (
      <div className="px-4 py-2 text-center text-xs text-muted-foreground border-t">
        Applying your changes — this takes a moment...
      </div>
    );
  }
  if (status.kind === "payloadRejected") {
    return (
      <div className="px-4 py-2 text-center text-xs text-destructive border-t bg-destructive/5">
        Image too large. Send a smaller file to keep chatting.
      </div>
    );
  }
  return null;
}

// Sentinel used while ChatSessionMounts spins up the real runtime.
const PLACEHOLDER_RUNTIME = {} as AssistantRuntime;

interface ChatProps {
  agentId: string;
  agentName: string;
  configuring?: boolean;
  isPersonal?: boolean;
  avatarUrl?: string;
  canEdit?: boolean;
}

export function Chat({
  agentId,
  agentName,
  configuring = false,
  isPersonal = false,
  avatarUrl,
  canEdit = false,
}: ChatProps) {
  const { getAgent } = useAgentsContext();
  const liveAgent = getAgent(agentId);
  const displayName = liveAgent?.name ?? agentName;
  const displayAvatar = liveAgent
    ? getAgentAvatarSvg({ avatarSeed: liveAgent.avatarSeed, name: liveAgent.name })
    : avatarUrl;
  const displayIsPersonal = liveAgent?.isPersonal ?? isPersonal;

  const { bundle: chatBundle, publish } = useChatSession(agentId);

  // Register this agent with the provider on first mount so
  // ChatSessionMounts spins up a hidden runtime instance.
  useEffect(() => {
    if (!chatBundle) {
      publish({
        runtime: PLACEHOLDER_RUNTIME,
        isRunning: false,
        isConnected: false,
        isHistoryLoaded: false,
        hasInitialContent: false,
        isOpenClawConnected: false,
        isDelayed: false,
        reconnectExhausted: false,
        payloadRejected: false,
        isOrphaned: false,
        onRetryContinue: () => {},
        onRetryResend: () => {},
        lastError: null,
      });
    }
  }, [chatBundle, publish]);

  // Hooks must be called unconditionally (Rules of Hooks), so we destructure
  // bundle fields with defaults and call useChatStatus on every render —
  // including the initial render where the bundle is still undefined or the
  // placeholder. The computed status is intentionally discarded by the
  // early `return null` below; once the real bundle arrives, the next
  // render produces a real status that drives the UI.
  const runtime = chatBundle?.runtime ?? PLACEHOLDER_RUNTIME;
  const isRunning = chatBundle?.isRunning ?? false;
  const isConnected = chatBundle?.isConnected ?? false;
  const isDelayed = chatBundle?.isDelayed ?? false;
  const isHistoryLoaded = chatBundle?.isHistoryLoaded ?? false;
  const hasInitialContent = chatBundle?.hasInitialContent ?? false;
  const isOpenClawConnected = chatBundle?.isOpenClawConnected ?? false;
  const reconnectExhausted = chatBundle?.reconnectExhausted ?? false;
  const payloadRejected = chatBundle?.payloadRejected ?? false;
  const onRetryContinue = chatBundle?.onRetryContinue ?? (() => {});
  const onRetryResend = chatBundle?.onRetryResend ?? (() => {});

  const chatStatus = useChatStatus({
    isConnected,
    isOpenClawConnected,
    isHistoryLoaded,
    hasInitialContent,
    isRunning,
    reconnectExhausted,
    payloadRejected,
    configuring,
  });

  const indicator = getStatusIndicator(chatStatus);

  if (!chatBundle || chatBundle.runtime === PLACEHOLDER_RUNTIME) {
    return null; // Brief flash before ChatSessionMounts publishes the real bundle
  }

  return (
    <AgentIdContext.Provider value={agentId}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatStatusContext.Provider value={chatStatus}>
          <RetryContinueContext.Provider value={onRetryContinue}>
            <RetryResendContext.Provider value={onRetryResend}>
              <AgentAvatarContext.Provider value={displayAvatar ?? null}>
                <div className="flex flex-col h-full min-h-0">
                  <MobileChatHeader
                    agentId={agentId}
                    agentName={displayName}
                    avatarUrl={displayAvatar}
                    canEdit={canEdit}
                  />
                  <header className="hidden md:flex p-4 border-b items-center justify-between shrink-0">
                    <div className="flex items-center gap-2 animate-in fade-in duration-300">
                      {displayAvatar && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={displayAvatar} alt="" className="size-7 rounded-full" />
                      )}
                      <h1 className="font-bold">{displayName}</h1>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="text-xs font-normal">
                              {displayIsPersonal ? "Private" : "Shared"}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            {displayIsPersonal
                              ? "Your conversations are private and not shared with anyone."
                              : "Your conversations help build team knowledge that's available to all team members."}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <div className="flex items-center gap-3">
                      {canEdit && (
                        <Link
                          href={`/chat/${agentId}/settings`}
                          aria-label="Settings"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Settings className="size-5" />
                        </Link>
                      )}
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={indicator.label}
                              className="cursor-default p-1.5 -m-1.5 inline-flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span
                                className={`size-2 rounded-full shrink-0 ${indicator.colorClass}`}
                              />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{indicator.label}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </header>
                  <div className="flex-1 min-h-0 animate-in fade-in duration-300">
                    <Thread />
                  </div>
                  {!displayIsPersonal && (
                    <p className="text-xs text-muted-foreground px-3 py-1">
                      Files uploaded here are visible to anyone with access to this agent.
                    </p>
                  )}
                  <ChatStatusBanner status={chatStatus} isDelayed={isDelayed} />
                </div>
              </AgentAvatarContext.Provider>
            </RetryResendContext.Provider>
          </RetryContinueContext.Provider>
        </ChatStatusContext.Provider>
      </AssistantRuntimeProvider>
    </AgentIdContext.Provider>
  );
}
