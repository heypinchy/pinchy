import type { OpenClawClient, ChatAttachment } from "openclaw-node";
import type { WebSocket } from "ws";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { isEnterprise } from "@/lib/enterprise";
import { appendAuditLog } from "@/lib/audit";
import { SessionCache } from "@/server/session-cache";
import { getErrorHint } from "@/server/error-hints";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { eq } from "drizzle-orm";

const WS_OPEN = 1;
const CONNECTION_TIMEOUT_MS = 10_000;
// Browsers and intermediate proxies close idle WebSockets after ~30-60s of
// silence. While the agent is in a slow tool-use loop (e.g. local Ollama
// thinking for >60s between turns), the server must keep the socket alive
// with periodic frames. We send a "thinking" heartbeat every 15s — frequent
// enough to defeat any reasonable idle timer, sparse enough not to spam.
const THINKING_HEARTBEAT_MS = 15_000;

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
  content?: unknown;
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
    return `agent:${agentId}:direct:${this.userId}`;
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

    const enterprise = await isEnterprise();
    const effVis = effectiveVisibility(agent.visibility, enterprise);
    const needsGroups = this.userRole !== "admin" && effVis === "restricted";

    const [userGroupIds, agentGroupIds] = await Promise.all([
      needsGroups ? getUserGroupIds(this.userId) : Promise.resolve([]),
      needsGroups ? getAgentGroupIds(message.agentId) : Promise.resolve([]),
    ]);

    try {
      assertAgentAccess(agent, this.userId, this.userRole, userGroupIds, agentGroupIds, enterprise);
    } catch {
      appendAuditLog({
        actorType: "user",
        actorId: this.userId,
        eventType: "tool.denied",
        resource: `agent:${message.agentId}`,
        detail: { reason: "access_denied" },
        outcome: "failure",
      }).catch((err) => {
        console.error("Failed to write audit log for tool.denied:", err);
      });
      this.sendToClient(clientWs, { type: "error", message: "Access denied" });
      return;
    }

    if (message.type === "history") {
      return this.handleHistory(clientWs, agent);
    }

    const sessionKey = this.computeSessionKey(message.agentId);

    let messageId = crypto.randomUUID();

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

      // Build extraSystemPrompt from user name + context + greeting
      const extraPromptParts: string[] = [];
      const user = await db.query.users.findFirst({
        where: eq(users.id, this.userId),
      });
      if (user?.name) {
        extraPromptParts.push(`## Current user\nName: ${user.name}`);
      }
      if (!agent.isPersonal && user?.context) {
        extraPromptParts.push(`## About the current user\n${user.context}`);
      }
      if (!this.sessionCache.has(sessionKey) && agent.greetingMessage) {
        const personalizedGreeting = this.resolveUserPlaceholder(agent.greetingMessage, user?.name);
        extraPromptParts.push(
          `The user just opened this chat for the first time. You already greeted them with this message: "${personalizedGreeting}". Do not introduce yourself again. Continue the conversation naturally.`
        );
      }
      if (extraPromptParts.length > 0) {
        chatOptions.extraSystemPrompt = extraPromptParts.join("\n\n");
      }

      const stream = this.openclawClient.chat(text, chatOptions);

      // Tell the client immediately that the request is in flight so the UI
      // can render a thinking indicator. Without this, slow backends (e.g.
      // local Ollama with tool-use loops) leave the user staring at a blank
      // chat for tens of seconds.
      this.sendToClient(clientWs, {
        type: "thinking",
        messageId,
      });

      // Heartbeat is intentionally deferred until the first chunk arrives.
      // Starting it immediately would reset the client-side stuck timer even
      // when OpenClaw's stream hangs before producing any output (e.g. after a
      // restart), trapping the user in an infinite spinner. Once the first
      // chunk arrives we know OpenClaw is actively responding, so heartbeats
      // are safe to send between turns.
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

      try {
        // Debug shortcut: "__debug_error:<type>" messages bypass OpenClaw and
        // inject a fake error chunk directly. Remove before going to production.
        const DEBUG_ERRORS: Record<string, string> = {
          billing:
            "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
          invalid_key: "Invalid API key provided. You must provide a valid API key.",
          unauthorized: "Unauthorized: invalid x-api-key",
          quota: "You exceeded your current quota, please check your plan and billing details.",
          rate_limit: "Rate limit exceeded: Too many requests. Please retry after 60 seconds.",
          timeout: "Request timeout: The server did not respond in time.",
          overloaded: "The server is overloaded. Please try again later. (529)",
          unknown: "Unexpected internal error: SIGPIPE broken pipe during inference.",
        };
        if (text.startsWith("__debug_error:")) {
          const key = text.replace("__debug_error:", "").trim();
          const fakeError =
            DEBUG_ERRORS[key] ??
            `Unknown debug error type: "${key}". Available: ${Object.keys(DEBUG_ERRORS).join(", ")}`;
          await new Promise((r) => setTimeout(r, 600)); // brief fake thinking delay
          this.sendToClient(clientWs, {
            type: "error",
            agentName: agent.name,
            providerError: fakeError,
            hint: getErrorHint(fakeError, this.userRole),
            messageId,
          });
          return;
        }

        for await (const chunk of stream) {
          // Stop consuming the stream if the browser disconnected — frees
          // server resources while letting OpenClaw finish on its side.
          if (clientWs.readyState !== WS_OPEN) {
            break;
          }

          // Start keep-alive heartbeats on the first chunk. Deferring until
          // here ensures heartbeats only flow while OpenClaw is actively
          // producing output — not while it may be hung before the first byte.
          if (heartbeatInterval === null) {
            heartbeatInterval = setInterval(() => {
              if (clientWs.readyState === WS_OPEN) {
                this.sendToClient(clientWs, {
                  type: "thinking",
                  messageId,
                });
              }
            }, THINKING_HEARTBEAT_MS);
          }

          if (chunk.type === "text") {
            const cleaned = chunk.text.replace(/<\/?final>/g, "");
            if (cleaned) {
              this.sendToClient(clientWs, {
                type: "chunk",
                content: cleaned,
                messageId,
              });
            }
          }

          if (chunk.type === "error") {
            console.error("OpenClaw error chunk:", chunk.text);
            this.sendToClient(clientWs, {
              type: "error",
              agentName: agent.name,
              providerError: chunk.text,
              hint: getErrorHint(chunk.text, this.userRole),
              messageId,
            });
          }

          if (chunk.type === "done") {
            this.sessionCache.add(sessionKey);
            this.sendToClient(clientWs, {
              type: "done",
              messageId,
            });

            // Next agent turn gets a fresh messageId so the browser
            // creates a separate assistant message — consistent with
            // how OpenClaw stores them in history.
            messageId = crypto.randomUUID();
          }
        }

        // Tell the client the entire request is finished. Unlike "done" events
        // (which fire between agent turns) this is sent exactly once after the
        // iterator is exhausted, so the UI can confidently turn off the
        // thinking indicator only when no more chunks will arrive.
        // No messageId — this terminator is not tied to any specific turn.
        this.sendToClient(clientWs, {
          type: "complete",
        });
      } finally {
        if (heartbeatInterval !== null) {
          clearInterval(heartbeatInterval);
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

      // Always fetch history directly from OpenClaw — the session cache
      // can miss sessions (e.g. after agent switching or timing gaps)
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

          // Strip protocol tags from assistant responses
          content = content.replace(/<\/?final>/g, "");

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

      if (messages.length > 0) {
        this.sessionCache.add(sessionKey);
        this.sendToClient(clientWs, { type: "history", messages });
      } else {
        // No history — show greeting for new conversations
        const greeting = await this.getPersonalizedGreeting(agent.greetingMessage);
        const greetingMessages = greeting ? [{ role: "assistant", content: greeting }] : [];
        this.sendToClient(clientWs, { type: "history", messages: greetingMessages });
      }
    } catch (err) {
      // If history fetch fails (e.g. session doesn't exist), fall back to greeting
      const greeting = await this.getPersonalizedGreeting(agent.greetingMessage);
      const greetingMessages = greeting ? [{ role: "assistant", content: greeting }] : [];
      this.sendToClient(clientWs, { type: "history", messages: greetingMessages });
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

  private resolveUserPlaceholder(text: string, userName: string | null | undefined): string {
    if (userName) {
      return text.replace(/\{user\}/g, userName);
    }
    // Remove ", {user}" patterns first, then any remaining "{user}" with trailing punctuation
    return text.replace(/,\s*\{user\}/g, "").replace(/\{user\}[,.]?\s*/g, "");
  }

  private async getPersonalizedGreeting(
    rawGreeting: string | null | undefined
  ): Promise<string | null> {
    if (!rawGreeting) return null;
    if (!rawGreeting.includes("{user}")) return rawGreeting;
    const user = await db.query.users.findFirst({ where: eq(users.id, this.userId) });
    return this.resolveUserPlaceholder(rawGreeting, user?.name);
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
