import type { OpenClawClient, ChatAttachment } from "openclaw-node";
import type { WebSocket } from "ws";
import { assertAgentAccess } from "@/lib/agent-access";
import { appendAuditLog } from "@/lib/audit";
import { SessionCache } from "@/server/session-cache";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

const WS_OPEN = 1;
const CONNECTION_TIMEOUT_MS = 10_000;

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface BrowserMessage {
  type: string;
  content: string | ContentPart[];
  agentId: string;
}

interface HistoryMessage {
  role: string;
  content: string | { type: string; text?: string }[];
  timestamp?: number;
}

export class ClientRouter {
  constructor(
    private openclawClient: OpenClawClient,
    private userId: string,
    private userRole: string,
    private sessionCache: SessionCache
  ) {}

  private computeSessionKey(agentId: string): string {
    return `agent:${agentId}:user-${this.userId}`;
  }

  async handleMessage(clientWs: WebSocket, message: BrowserMessage): Promise<void> {
    // Look up agent and check access
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, message.agentId),
    });

    if (!agent) {
      this.sendToClient(clientWs, { type: "error", message: "Agent not found" });
      return;
    }

    try {
      assertAgentAccess(agent, this.userId, this.userRole);
    } catch {
      appendAuditLog({
        actorType: "user",
        actorId: this.userId,
        eventType: "tool.denied",
        resource: `agent:${message.agentId}`,
        detail: { reason: "access_denied" },
      }).catch(() => {});
      this.sendToClient(clientWs, { type: "error", message: "Access denied" });
      return;
    }

    if (message.type === "history") {
      return this.handleHistory(clientWs, agent);
    }

    const sessionKey = this.computeSessionKey(message.agentId);

    const messageId = crypto.randomUUID();

    try {
      await this.waitForConnection();

      // Extract text and images from structured content
      let text: string;
      const attachments: ChatAttachment[] = [];

      if (Array.isArray(message.content)) {
        text = message.content
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text!)
          .join(" ");

        for (const part of message.content) {
          if (part.type === "image_url" && part.image_url?.url) {
            const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              attachments.push({ mimeType: match[1], content: match[2] });
            }
          }
        }
      } else {
        text = message.content;
      }

      const chatOptions: Record<string, unknown> = {
        agentId: message.agentId,
        sessionKey,
      };
      if (attachments.length > 0) {
        chatOptions.attachments = attachments;
      }
      if (!this.sessionCache.has(sessionKey) && agent.greetingMessage) {
        chatOptions.extraSystemPrompt = `The user just opened this chat for the first time. You already greeted them with this message: "${agent.greetingMessage}". Do not introduce yourself again. Continue the conversation naturally.`;
      }

      const stream = this.openclawClient.chat(text, chatOptions);

      for await (const chunk of stream) {
        // Stop consuming the stream if the browser disconnected — frees
        // server resources while letting OpenClaw finish on its side.
        if (clientWs.readyState !== WS_OPEN) {
          break;
        }

        if (chunk.type === "text") {
          this.sendToClient(clientWs, {
            type: "chunk",
            content: chunk.text,
            messageId,
          });
        }

        if (chunk.type === "tool_use" || chunk.type === "tool_result") {
          appendAuditLog({
            actorType: "agent",
            actorId: message.agentId,
            eventType: "tool.execute",
            resource: `agent:${message.agentId}`,
            detail: { chunkType: chunk.type, text: chunk.text },
          }).catch(() => {});
        }

        if (chunk.type === "error") {
          console.error("OpenClaw error chunk:", chunk.text);
          this.sendToClient(clientWs, {
            type: "error",
            message:
              "Something went wrong connecting to the agent. Try refreshing — if it persists, check the logs.",
            messageId,
          });
        }

        if (chunk.type === "done") {
          this.sessionCache.add(sessionKey);
          this.sendToClient(clientWs, {
            type: "done",
            messageId,
          });
        }
      }
    } catch (err) {
      this.sendToClient(clientWs, {
        type: "error",
        message: this.sanitizeError(err),
        messageId,
      });
    }
  }

  private async handleHistory(
    clientWs: WebSocket,
    agent: { id: string; greetingMessage?: string | null }
  ): Promise<void> {
    const sessionKey = this.computeSessionKey(agent.id);

    try {
      await this.waitForConnection();

      // Check if session exists in OpenClaw (cached)
      if (this.sessionCache.isStale()) {
        try {
          const result = await this.openclawClient.sessions.list();
          const sessions = (result as { sessions?: { key: string }[] })?.sessions ?? [];
          this.sessionCache.refresh(sessions);
        } catch {
          // If we can't list sessions, fall back to greeting/empty
          const messages = agent.greetingMessage
            ? [{ role: "assistant", content: agent.greetingMessage }]
            : [];
          this.sendToClient(clientWs, { type: "history", messages });
          return;
        }
      }

      if (!this.sessionCache.has(sessionKey)) {
        // Session doesn't exist in OpenClaw yet — return greeting or empty
        const messages = agent.greetingMessage
          ? [{ role: "assistant", content: agent.greetingMessage }]
          : [];
        this.sendToClient(clientWs, { type: "history", messages });
        return;
      }

      // Session exists — fetch history from OpenClaw
      const result = (await this.openclawClient.sessions.history(sessionKey)) as {
        messages?: HistoryMessage[];
      };
      const rawMessages = result?.messages ?? [];

      const messages = rawMessages
        .filter((msg) => msg.role === "user" || msg.role === "assistant")
        .map((msg) => {
          let content: string;
          if (Array.isArray(msg.content)) {
            content = msg.content
              .filter((part: { type: string; text?: string }) => part.type === "text" && part.text)
              .map((part: { text?: string }) => part.text!)
              .join(" ");
          } else {
            content = typeof msg.content === "string" ? msg.content : "";
          }

          // Strip OpenClaw timestamp prefix from user messages
          if (msg.role === "user") {
            content = content.replace(/^\[.*?\]\s*/, "");
          }

          return {
            role: msg.role as "user" | "assistant",
            content,
            timestamp: msg.timestamp,
          };
        })
        .filter((msg) => msg.content);

      this.sendToClient(clientWs, { type: "history", messages });
    } catch (err) {
      this.sendToClient(clientWs, {
        type: "error",
        message: this.sanitizeError(err),
      });
    }
  }

  private waitForConnection(): Promise<void> {
    if (this.openclawClient.isConnected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.openclawClient.removeListener("connected", onConnected);
        reject(
          new Error("Agent runtime is not available right now. Please try again in a moment.")
        );
      }, CONNECTION_TIMEOUT_MS);

      const onConnected = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.openclawClient.once("connected", onConnected);
    });
  }

  private sanitizeError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    // Pass through user-facing messages from waitForConnection
    if (message.includes("not available")) {
      return message;
    }
    console.error("ClientRouter error:", message);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return "Something went wrong. Please try again.";
  }

  private sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
