"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  useExternalStoreRuntime,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  CompositeAttachmentAdapter,
  type ThreadMessageLike,
  type AppendMessage,
  type AssistantRuntime,
} from "@assistant-ui/react";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

interface WsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  timestamp?: string;
}

const STREAM_DONE_DEBOUNCE_MS = 1500;
const DELAY_HINT_MS = 15_000;

function convertMessage(msg: WsMessage): ThreadMessageLike {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
    { type: "text", text: msg.content },
  ];

  if (msg.images) {
    for (const image of msg.images) {
      parts.push({ type: "image", image });
    }
  }

  return {
    role: msg.role,
    content: parts,
    id: msg.id,
    metadata: msg.timestamp ? { custom: { timestamp: msg.timestamp } } : undefined,
  };
}

class CodeTextAttachmentAdapter extends SimpleTextAttachmentAdapter {
  public override accept =
    "text/plain,text/html,text/markdown,text/csv,text/xml,text/json,text/css,application/javascript,application/typescript,.js,.ts,.tsx,.jsx,.py,.rs,.go,.sh,.sql,.yaml,.yml,.toml,.json";
}

const attachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
  new CodeTextAttachmentAdapter(),
]);

const MAX_RECONNECT_ATTEMPTS = 10;

export function useWsRuntime(agentId: string): {
  runtime: AssistantRuntime;
  isConnected: boolean;
  isDelayed: boolean;
  isHistoryLoaded: boolean;
} {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isDelayed, setIsDelayed] = useState(false);
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    reconnectAttemptRef.current = 0;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws?agentId=${agentId}`);

      ws.onopen = () => {
        setIsConnected(true);
        reconnectAttemptRef.current = 0;
        ws.send(JSON.stringify({ type: "history", agentId }));
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsRunning(false);
        setIsHistoryLoaded(false);

        if (mountedRef.current && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
          reconnectAttemptRef.current++;
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        setIsConnected(false);
        setIsRunning(false);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "history") {
            setMessages((prev) => {
              if (prev.length > 0) return prev;
              return (data.messages ?? []).map(
                (msg: { role: string; content: string; timestamp?: string }) => ({
                  id: crypto.randomUUID(),
                  role: msg.role === "system" ? "assistant" : msg.role,
                  content: msg.content,
                  timestamp: msg.timestamp,
                })
              );
            });
            setIsHistoryLoaded(true);
            return;
          }

          if (data.type === "chunk") {
            if (delayTimerRef.current) {
              clearTimeout(delayTimerRef.current);
              delayTimerRef.current = null;
            }
            setIsDelayed(false);

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
                  timestamp: new Date().toISOString(),
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
            if (delayTimerRef.current) {
              clearTimeout(delayTimerRef.current);
              delayTimerRef.current = null;
            }
            setIsDelayed(false);
            setIsRunning(false);
          }

          if (data.type === "error") {
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
            }
            if (delayTimerRef.current) {
              clearTimeout(delayTimerRef.current);
              delayTimerRef.current = null;
            }
            setIsDelayed(false);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: data.message || "An unknown error occurred.",
              },
            ]);
            setIsRunning(false);
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [agentId]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const textParts = message.content.filter((part) => part.type === "text");
      const text = textParts.map((part) => ("text" in part ? part.text : "")).join("");

      // Extract images from attachments (assistant-ui puts them there, not in content)
      const attachments =
        (
          message as {
            attachments?: Array<{
              type: string;
              content?: Array<{ type: string; image?: string }>;
            }>;
          }
        ).attachments ?? [];
      const images: string[] = [];
      for (const att of attachments) {
        if (att.type === "image" && att.content) {
          for (const c of att.content) {
            if (c.type === "image" && c.image) {
              images.push(c.image);
            }
          }
        }
      }

      // Check image size limit
      for (const img of images) {
        if (img.length > MAX_IMAGE_SIZE) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "Image exceeds the 5MB size limit. Please use a smaller image.",
            },
          ]);
          return;
        }
      }

      if (!text.trim() && images.length === 0) return;

      const userMessage: WsMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        ...(images.length > 0 && { images }),
      };

      setMessages((prev) => [...prev, userMessage]);
      setIsRunning(true);

      // Start delay hint timer
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
      }
      delayTimerRef.current = setTimeout(() => {
        setIsDelayed(true);
      }, DELAY_HINT_MS);

      // Build content: structured array if images present, plain string otherwise
      let wsContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
      if (images.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        if (text) {
          parts.push({ type: "text", text });
        }
        for (const img of images) {
          parts.push({ type: "image_url", image_url: { url: img } });
        }
        wsContent = parts;
      } else {
        wsContent = text;
      }

      wsRef.current?.send(
        JSON.stringify({
          type: "message",
          content: wsContent,
          agentId,
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
    adapters: {
      attachments: attachmentAdapter,
    },
  });

  return { runtime, isConnected, isDelayed, isHistoryLoaded };
}
