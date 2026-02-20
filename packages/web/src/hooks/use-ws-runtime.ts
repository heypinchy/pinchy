"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
  type AssistantRuntime,
} from "@assistant-ui/react";

interface WsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const STREAM_DONE_DEBOUNCE_MS = 1500;
const SESSION_KEY_PREFIX = "pinchy:session:";

export function getSessionKey(agentId: string): string | null {
  return localStorage.getItem(`${SESSION_KEY_PREFIX}${agentId}`);
}

export function clearSession(agentId: string): void {
  localStorage.removeItem(`${SESSION_KEY_PREFIX}${agentId}`);
}

function convertMessage(msg: WsMessage): ThreadMessageLike {
  return {
    role: msg.role,
    content: [{ type: "text", text: msg.content }],
    id: msg.id,
  };
}

export function useWsRuntime(agentId: string): {
  runtime: AssistantRuntime;
  isConnected: boolean;
} {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws?agentId=${agentId}`);

    ws.onopen = () => setIsConnected(true);

    ws.onclose = () => {
      setIsConnected(false);
      setIsRunning(false);
    };

    ws.onerror = () => {
      setIsConnected(false);
      setIsRunning(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "chunk") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.id === data.messageId) {
              return [...prev.slice(0, -1), { ...last, content: last.content + data.content }];
            }
            return [
              ...prev,
              {
                id: data.messageId,
                role: "assistant",
                content: data.content,
              },
            ];
          });

          // Reset debounce timer on each chunk
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = setTimeout(() => {
            setIsRunning(false);
          }, STREAM_DONE_DEBOUNCE_MS);
        }

        if (data.type === "done") {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          setIsRunning(false);
        }

        if (data.type === "error") {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          setIsRunning(false);
        }
      } catch {
        // Ignore unparseable messages
      }
    };

    wsRef.current = ws;

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      ws.close();
    };
  }, [agentId]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      // Extract text content from the AppendMessage
      const textParts = message.content.filter((part) => part.type === "text");
      const text = textParts.map((part) => ("text" in part ? part.text : "")).join("");

      if (!text.trim()) return;

      const userMessage: WsMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      };

      // Get or create a sessionKey for this agent
      let sessionKey = getSessionKey(agentId);
      if (!sessionKey) {
        sessionKey = crypto.randomUUID();
        localStorage.setItem(`${SESSION_KEY_PREFIX}${agentId}`, sessionKey);
      }

      setMessages((prev) => [...prev, userMessage]);
      setIsRunning(true);

      wsRef.current?.send(
        JSON.stringify({
          type: "message",
          content: text,
          agentId,
          sessionKey,
        })
      );
    },
    [agentId]
  );

  const convertedMessages = useMemo(() => messages.map(convertMessage), [messages]);

  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    isRunning,
    convertMessage: (msg: ThreadMessageLike) => msg,
    onNew,
  });

  return { runtime, isConnected };
}
