"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { create, type StoreApi, useStore } from "zustand";
import type { AssistantRuntime } from "@assistant-ui/react";
import type { PendingUpload } from "@/hooks/use-ws-runtime";

/**
 * Store key for a live chat runtime. Identifies one OpenClaw session within a
 * (user, agent) pair. When `chatId` is omitted the key is the bare `agentId` —
 * byte-identical to the pre-#508 key — so the legacy/default chat keeps its
 * existing entry, LRU ordering, and sidebar lookup unchanged.
 */
export function chatSessionKey(agentId: string, chatId?: string): string {
  return chatId ? `${agentId}:${chatId}` : agentId;
}

export interface RuntimeBundle {
  /**
   * The agent + optional chat this bundle belongs to (#508). Carried on the
   * bundle so ChatSessionMounts can pass them straight to useWsRuntime without
   * having to parse them back out of the composite store key.
   */
  agentId: string;
  chatId?: string;
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
  onRetryContinue: (reason: "orphan" | "partial_stream_failure" | "send_failure") => void;
  onRetryResend: (messageId: string) => void;
  lastError: string | null;
  pendingUploads: PendingUpload[];
  addPendingUpload: (file: File) => void;
  removePendingUpload: (localId: string) => void;
  retryPendingUpload: (localId: string) => void;
}

interface ChatSessionStoreState {
  bundles: Record<string, RuntimeBundle | undefined>;
}

interface ChatSessionStoreActions {
  publish: (key: string, bundle: RuntimeBundle) => void;
  remove: (key: string) => void;
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
    publish: (key, bundle) =>
      set((s) => {
        // Rebuild the bundles object so re-publishing an existing session
        // moves it to the most-recently-used (insertion-order last)
        // position. JS objects preserve string-key insertion order, so
        // the first key after this rebuild is the LRU candidate.
        const next: Record<string, RuntimeBundle | undefined> = {};
        for (const [k, v] of Object.entries(s.bundles)) {
          if (k !== key && v !== undefined) next[k] = v;
        }
        next[key] = bundle;
        // Enforce the cap. Worst case: overshoot by exactly one (the new
        // entry that just pushed us over). Drop the oldest until we fit.
        const keys = Object.keys(next);
        for (let i = 0; keys.length - i > MAX_LIVE_BUNDLES; i++) {
          delete next[keys[i]];
        }
        return { bundles: next };
      }),
    remove: (key) =>
      set((s) => {
        const next = { ...s.bundles };
        delete next[key];
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

export function useChatSession(agentId: string, chatId?: string) {
  const store = useStoreOrThrow();
  const key = chatSessionKey(agentId, chatId);
  const bundle = useStore(store, (s) => s.bundles[key]);
  const publish = useStore(store, (s) => s.publish);
  const remove = useStore(store, (s) => s.remove);

  return useMemo(
    () => ({
      bundle,
      publish: (b: RuntimeBundle) => publish(key, b),
      remove: () => remove(key),
    }),
    [bundle, publish, remove, key]
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

/**
 * Live chat sessions to mount, one per (agentId, chatId) pair (#508). Derived
 * from the bundles' own `agentId`/`chatId` fields rather than by parsing the
 * composite store key, so it stays correct regardless of the key format.
 */
export function useVisitedSessions(): Array<{ key: string; agentId: string; chatId?: string }> {
  const store = useStoreOrThrow();
  // Serialize to a stable JSON string so the snapshot is referentially stable
  // between renders when the set of visited sessions hasn't changed.
  const serialized = useStore(store, (s) =>
    JSON.stringify(
      Object.entries(s.bundles)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, v!.agentId, v!.chatId ?? null] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    )
  );
  return useMemo(() => {
    const triples = JSON.parse(serialized) as Array<[string, string, string | null]>;
    return triples.map(([key, agentId, chatId]) => ({
      key,
      agentId,
      chatId: chatId ?? undefined,
    }));
  }, [serialized]);
}
