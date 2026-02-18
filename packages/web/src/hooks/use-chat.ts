"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function useChat(agentId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/ws?agentId=${agentId}`,
    );

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onerror = () => setIsConnected(false);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "chunk") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.id === data.messageId) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + data.content },
              ];
            }
            return [
              ...prev,
              { id: data.messageId, role: "assistant", content: data.content },
            ];
          });
        }
      } catch {
        // Ignore unparseable messages
      }
    };

    wsRef.current = ws;
    return () => ws.close();
  }, [agentId]);

  const sendMessage = useCallback(
    (content: string) => {
      const message: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content,
      };
      setMessages((prev) => [...prev, message]);

      wsRef.current?.send(
        JSON.stringify({
          type: "message",
          content,
          agentId,
        }),
      );
    },
    [agentId],
  );

  return { messages, sendMessage, isConnected };
}
