"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { create, type StoreApi, useStore } from "zustand";
import type { AssistantRuntime } from "@assistant-ui/react";

export interface RuntimeBundle {
  runtime: AssistantRuntime;
  isRunning: boolean;
  isConnected: boolean;
  isHistoryLoaded: boolean;
  isReconcilingMessages: boolean;
  hasInitialContent: boolean;
  isOpenClawConnected: boolean;
  isDelayed: boolean;
  reconnectExhausted: boolean;
  payloadRejected: boolean;
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

/**
 * Maximum number of live runtime bundles kept in the store. Each bundle
 * pins an open WebSocket (via the surviving <ChatSessionInstance>) plus
 * up to 200 cached messages. Without a cap, a long-lived tab that opens
 * many agents accumulates unbounded WebSockets and memory. When this cap
 * is exceeded, the least-recently-published bundle is evicted; the
 * evicted agent reconnects fresh when the user navigates back to it.
 *
 * 20 was chosen as a generous "many agents per session" number that
 * still bounds resource usage to a few MB and a few dozen WebSockets.
 */
export const MAX_LIVE_BUNDLES = 20;

/** Exported for internal use by ChatSessionMounts only — not part of public API. */
export const ChatSessionStoreContext = createContext<Store | null>(null);

function createChatSessionStore(): Store {
  return create<ChatSessionStoreState & ChatSessionStoreActions>()((set) => ({
    bundles: {},
    publish: (agentId, bundle) =>
      set((s) => {
        // Rebuild the bundles object so re-publishing an existing agent
        // moves it to the most-recently-used (insertion-order last)
        // position. JS objects preserve string-key insertion order, so
        // the first key after this rebuild is the LRU candidate.
        const next: Record<string, RuntimeBundle | undefined> = {};
        for (const [k, v] of Object.entries(s.bundles)) {
          if (k !== agentId && v !== undefined) next[k] = v;
        }
        next[agentId] = bundle;
        // Enforce the cap. Worst case: overshoot by exactly one (the new
        // entry that just pushed us over). Drop the oldest until we fit.
        const keys = Object.keys(next);
        for (let i = 0; keys.length - i > MAX_LIVE_BUNDLES; i++) {
          delete next[keys[i]];
        }
        return { bundles: next };
      }),
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
  return (
    <ChatSessionStoreContext.Provider value={store}>{children}</ChatSessionStoreContext.Provider>
  );
}

function useStoreOrThrow(): Store {
  const store = useContext(ChatSessionStoreContext);
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
