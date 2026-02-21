import type { OpenClawClient, ChatAttachment } from "openclaw-node";
import type { WebSocket } from "ws";
import { readSessionHistory } from "@/lib/session-history";
import { assertAgentAccess } from "@/lib/agent-access";
import { getOrCreateSession } from "@/lib/chat-sessions";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

const WS_OPEN = 1;

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

export class ClientRouter {
  constructor(
    private openclawClient: OpenClawClient,
    private userId: string,
    private userRole: string
  ) {}

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
      this.sendToClient(clientWs, { type: "error", message: "Access denied" });
      return;
    }

    if (message.type === "history") {
      return this.handleHistory(clientWs, message.agentId);
    }

    // Get server-side session
    const session = await getOrCreateSession(this.userId, message.agentId);

    const messageId = crypto.randomUUID();

    try {
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

      const chatOptions: Record<string, unknown> = { sessionKey: session.sessionKey };
      if (attachments.length > 0) {
        chatOptions.attachments = attachments;
      }

      const stream = this.openclawClient.chat(text, chatOptions);

      for await (const chunk of stream) {
        if (chunk.type === "text") {
          this.sendToClient(clientWs, {
            type: "chunk",
            content: chunk.text,
            messageId,
          });
        }

        if (chunk.type === "done") {
          this.sendToClient(clientWs, {
            type: "done",
            messageId,
          });
        }
      }
    } catch (err) {
      this.sendToClient(clientWs, {
        type: "error",
        message: err instanceof Error ? err.message : "Unknown error",
        messageId,
      });
    }
  }

  private async handleHistory(clientWs: WebSocket, agentId: string): Promise<void> {
    const session = await getOrCreateSession(this.userId, agentId);
    const messages = readSessionHistory(session.sessionKey);
    this.sendToClient(clientWs, { type: "history", messages });
  }

  private sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
