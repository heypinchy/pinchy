"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { create, type StoreApi, useStore } from "zustand";
import type { AssistantRuntime } from "@assistant-ui/react";

export interface RuntimeBundle {
  runtime: AssistantRuntime;
  isRunning: boolean;
  isConnected: boolean;
  isHistoryLoaded: boolean;
  hasInitialContent: boolean;
  isOpenClawConnected: boolean;
  isDelayed: boolean;
  reconnectExhausted: boolean;
  isOrphaned: boolean;
  onRetryContinue: (reason: "orphan" | "partial_stream_failure" | "send_failure") => void;
  onRetryResend: (messageId: string) => void;
  lastError: string | null;
}

interface ChatSessionStoreState {
  bundles: Record<string, RuntimeBundle | undefined>;
}

interface ChatSessionStoreActions {
  publish: (agentId: string, bundle: RuntimeBundle) => void;
  remove: (agentId: string) => void;
}

type Store = StoreApi<ChatSessionStoreState & ChatSessionStoreActions>;

const ChatSessionContext = createContext<Store | null>(null);

function createChatSessionStore(): Store {
  return create<ChatSessionStoreState & ChatSessionStoreActions>()((set) => ({
    bundles: {},
    publish: (agentId, bundle) => set((s) => ({ bundles: { ...s.bundles, [agentId]: bundle } })),
    remove: (agentId) =>
      set((s) => {
        const next = { ...s.bundles };
        delete next[agentId];
        return { bundles: next };
      }),
  }));
}

export function ChatSessionProvider({ children }: { children: React.ReactNode }) {
  // useState initializer runs once — avoids accessing ref.current during render.
  const [store] = useState(createChatSessionStore);
  return <ChatSessionContext.Provider value={store}>{children}</ChatSessionContext.Provider>;
}

function useStoreOrThrow(): Store {
  const store = useContext(ChatSessionContext);
  if (!store) throw new Error("useChatSession must be used within ChatSessionProvider");
  return store;
}

export function useChatSession(agentId: string) {
  const store = useStoreOrThrow();
  const bundle = useStore(store, (s) => s.bundles[agentId]);
  const publish = useStore(store, (s) => s.publish);
  const remove = useStore(store, (s) => s.remove);

  return useMemo(
    () => ({
      bundle,
      publish: (b: RuntimeBundle) => publish(agentId, b),
      remove: () => remove(agentId),
    }),
    [bundle, publish, remove, agentId]
  );
}

export function useVisitedAgentIds(): string[] {
  const store = useStoreOrThrow();
  // Serialize to a stable string so useSyncExternalStore snapshot is referentially
  // stable between renders when the set of visited agents hasn't changed.
  const keysStr = useStore(store, (s) =>
    Object.entries(s.bundles)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
      .sort()
      .join("\0")
  );
  return useMemo(() => (keysStr ? keysStr.split("\0") : []), [keysStr]);
}
