"use client";

import { create } from "zustand";
import type { ConnectionRejection } from "@/hooks/use-ws-runtime";
import { chatSessionKey } from "@/components/chat-session-provider";

/**
 * Why a chat is not connected, as far as the browser and the server can tell
 * (#1422). Published by the hidden runtime instance and read by `<Chat>`; kept
 * out of `RuntimeBundle` so the provider's bundle contract stays untouched.
 */
export interface ChatConnectionInfo {
  /** The browser reports no network. */
  isOffline: boolean;
  /** The server refused the connection and said why. */
  rejection: ConnectionRejection | null;
}

const IDLE: ChatConnectionInfo = { isOffline: false, rejection: null };

interface State {
  byKey: Record<string, ChatConnectionInfo | undefined>;
}

const useConnectionStore = create<State>()(() => ({ byKey: {} }));

export function publishChatConnection(
  agentId: string,
  chatId: string | undefined,
  info: ChatConnectionInfo
): void {
  const key = chatSessionKey(agentId, chatId);
  useConnectionStore.setState((s) => {
    const current = s.byKey[key] ?? IDLE;
    if (current.isOffline === info.isOffline && current.rejection === info.rejection) return s;
    return { byKey: { ...s.byKey, [key]: info } };
  });
}

export function clearChatConnection(agentId: string, chatId?: string): void {
  const key = chatSessionKey(agentId, chatId);
  useConnectionStore.setState((s) => {
    if (!(key in s.byKey)) return s;
    const next = { ...s.byKey };
    delete next[key];
    return { byKey: next };
  });
}

export function useChatConnection(agentId: string, chatId?: string): ChatConnectionInfo {
  const key = chatSessionKey(agentId, chatId);
  return useConnectionStore((s) => s.byKey[key] ?? IDLE);
}
