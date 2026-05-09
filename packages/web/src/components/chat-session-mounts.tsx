"use client";

import { useContext, useEffect } from "react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";
import { useVisitedAgentIds, ChatSessionStoreContext } from "@/components/chat-session-provider";

export function ChatSessionMounts() {
  const visitedAgentIds = useVisitedAgentIds();
  return (
    <>
      {visitedAgentIds.map((agentId) => (
        <ChatSessionInstance key={agentId} agentId={agentId} />
      ))}
    </>
  );
}

function ChatSessionInstance({ agentId }: { agentId: string }) {
  const bundle = useWsRuntime(agentId);

  // Access the store directly (not via useStore) so we can call publish
  // without subscribing to the bundle in the store. Subscribing to our own
  // entry would cause an infinite publish loop:
  //   publish → store update → re-render → publish → …
  const store = useContext(ChatSessionStoreContext);
  if (!store) throw new Error("ChatSessionMounts must be used within ChatSessionProvider");

  // Capture the bundle callbacks in the effect closure. In production,
  // useWsRuntime memoizes them with useCallback so they are stable across
  // renders. The effect deps below intentionally exclude the callbacks to
  // avoid churning publishes on every render in environments (e.g. tests)
  // where the callbacks are not memoized.
  const { onRetryContinue, onRetryResend } = bundle;

  useEffect(() => {
    const lastError = bundle.isOrphaned ? "The agent did not respond" : null;
    store.getState().publish(agentId, {
      runtime: bundle.runtime,
      isRunning: bundle.isRunning,
      isConnected: bundle.isConnected,
      isHistoryLoaded: bundle.isHistoryLoaded,
      hasInitialContent: bundle.hasInitialContent,
      isOpenClawConnected: bundle.isOpenClawConnected,
      isDelayed: bundle.isDelayed,
      reconnectExhausted: bundle.reconnectExhausted,
      isOrphaned: bundle.isOrphaned,
      onRetryContinue,
      onRetryResend,
      lastError,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agentId,
    store,
    bundle.runtime,
    bundle.isRunning,
    bundle.isConnected,
    bundle.isHistoryLoaded,
    bundle.hasInitialContent,
    bundle.isOpenClawConnected,
    bundle.isDelayed,
    bundle.reconnectExhausted,
    bundle.isOrphaned,
  ]);

  return null;
}
