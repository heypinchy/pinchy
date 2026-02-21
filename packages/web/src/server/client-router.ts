import type { OpenClawClient, ContentPart } from "openclaw-node";
import type { WebSocket } from "ws";
import { readSessionHistory } from "@/lib/session-history";
import { assertAgentAccess } from "@/lib/agent-access";
import { getOrCreateSession } from "@/lib/chat-sessions";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

const WS_OPEN = 1;

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
      // Gateway only accepts string messages — extract text from ContentPart[]
      const text = Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === "text" && "text" in part)
            .map((part) => (part as { text: string }).text)
            .join(" ")
        : message.content;

      const stream = this.openclawClient.chat(text, { sessionKey: session.sessionKey });

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
