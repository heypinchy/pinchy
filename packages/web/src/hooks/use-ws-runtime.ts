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
      const textParts = message.content.filter((part) => part.type === "text");
      const text = textParts.map((part) => ("text" in part ? part.text : "")).join("");
      const imageParts = message.content.filter((part) => part.type === "image");

      // Check image size limit
      for (const part of imageParts) {
        if (
          "image" in part &&
          typeof part.image === "string" &&
          part.image.length > MAX_IMAGE_SIZE
        ) {
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

      if (!text.trim() && imageParts.length === 0) return;

      const images = imageParts
        .map((part) => ("image" in part ? (part.image as string) : ""))
        .filter(Boolean);

      const userMessage: WsMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        ...(images.length > 0 && { images }),
      };

      // Get or create a sessionKey for this agent
      let sessionKey = getSessionKey(agentId);
      if (!sessionKey) {
        sessionKey = crypto.randomUUID();
        localStorage.setItem(`${SESSION_KEY_PREFIX}${agentId}`, sessionKey);
      }

      setMessages((prev) => [...prev, userMessage]);
      setIsRunning(true);

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
    adapters: {
      attachments: attachmentAdapter,
    },
  });

  return { runtime, isConnected };
}
