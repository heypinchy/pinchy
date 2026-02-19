import type { OpenClawClient } from "openclaw-node";
import type { WebSocket } from "ws";

const WS_OPEN = 1;

interface BrowserMessage {
  type: string;
  content: string;
  agentId: string;
}

export class ClientRouter {
  constructor(private openclawClient: OpenClawClient) {}

  async handleMessage(clientWs: WebSocket, message: BrowserMessage): Promise<void> {
    const messageId = crypto.randomUUID();

    try {
      const stream = this.openclawClient.chat(message.content, {
        agentId: message.agentId,
      });

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

  private sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
