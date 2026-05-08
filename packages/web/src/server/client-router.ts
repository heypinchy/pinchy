import type { OpenClawClient, ChatAttachment, ChatChunk } from "openclaw-node";
import type { WebSocket } from "ws";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { isEnterprise } from "@/lib/enterprise";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { shouldEmitModelUnavailableAudit } from "@/server/model-unavailable-throttle";
import { SessionCache } from "@/server/session-cache";
import { getErrorHint } from "@/server/error-hints";
import { classifyModelError } from "@/server/model-error-classifier";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { sanitizeFilename, validateUploadBuffer } from "@/lib/upload-validation";
import { persistAttachment } from "@/lib/uploads";

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

type RetryReason = "orphan" | "partial_stream_failure" | "send_failure";
const ALLOWED_RETRY_REASONS: ReadonlySet<string> = new Set([
  "orphan",
  "partial_stream_failure",
  "send_failure",
]);

interface ChatMessage {
  type: "message";
  content: string | ContentPart[];
  agentId: string;
  clientMessageId?: string;
  isRetry?: boolean;
  /** Recovery scenario behind a retry — surfaced in the audit log. */
  retryReason?: RetryReason;
  filenames?: string[];
}

interface HistoryRequestMessage {
  type: "history";
  agentId: string;
}

type BrowserMessage = ChatMessage | HistoryRequestMessage;

interface HistoryMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
}

export interface ProcessedWorkspaceRef {
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ProcessAttachmentsResult {
  chatAttachments: ChatAttachment[];
  workspaceRefs: ProcessedWorkspaceRef[];
}

export interface ProcessAttachmentsParams {
  agentId: string;
  uploaderUserId: string;
  sessionKey: string;
  contentParts: ContentPart[];
  claimedFilenames?: string[];
}

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

export async function processIncomingAttachments(
  params: ProcessAttachmentsParams
): Promise<ProcessAttachmentsResult> {
  const { agentId, contentParts } = params;
  const chatAttachments: ChatAttachment[] = [];
  const workspaceRefs: ProcessedWorkspaceRef[] = [];

  let imageIdx = 0;
  for (const part of contentParts) {
    if (part.type !== "image_url" || !part.image_url?.url) continue;
    const match = part.image_url.url.match(DATA_URL_RE);
    if (!match) continue;

    const claimedMime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, "base64");

    const detectedMime = await validateUploadBuffer(buffer, claimedMime);

    const claimedName = params.claimedFilenames?.[imageIdx] ?? "upload";
    const safeName = sanitizeFilename(claimedName);

    const persisted = await persistAttachment({
      agentId,
      filename: safeName,
      mimeType: detectedMime,
      buffer,
    });

    chatAttachments.push({ mimeType: detectedMime, fileName: safeName, content: base64 });
    workspaceRefs.push({
      relativePath: persisted.relativePath,
      mimeType: detectedMime,
      sizeBytes: buffer.length,
    });
    imageIdx++;
  }

  return { chatAttachments, workspaceRefs };
}

export function buildUploadHint(refs: ProcessedWorkspaceRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map(
    (r) => `- \`${r.relativePath}\` (${r.mimeType}, ${formatBytes(r.sizeBytes)})`
  );
  return [
    "## User uploaded files",
    "The user just uploaded these files to the agent workspace:",
    ...lines,
    "",
    "These files are also attached inline to this message — read them directly.",
    "For tasks requiring the file path (e.g. attaching to Odoo, copying, listing later), use the workspace paths above.",
  ].join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
      this.sendToClient(clientWs, { type: "error", message: "Access denied" });
      const auditEntry = {
        actorType: "user" as const,
        actorId: this.userId,
        eventType: "tool.denied" as const,
        resource: `agent:${message.agentId}`,
        detail: { reason: "access_denied" },
        outcome: "failure" as const,
      };
      try {
        await appendAuditLog(auditEntry);
      } catch (err) {
        recordAuditFailure(err, auditEntry);
      }
      return;
    }

    if (message.type === "history") {
      return this.handleHistory(clientWs, agent);
    }

    const sessionKey = this.computeSessionKey(message.agentId);

    const messageId = crypto.randomUUID();

    try {
      await this.waitForConnection();

      // Extract text from structured content
      let text: string;

      if (Array.isArray(message.content)) {
        text = message.content
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text!)
          .join(" ");
      } else {
        text = message.content;
      }

      // Process and validate attachments (validation, persistence, dedup)
      let chatAttachments: ChatAttachment[] = [];
      let workspaceRefs: ProcessedWorkspaceRef[] = [];
      try {
        const result = await processIncomingAttachments({
          agentId: message.agentId,
          uploaderUserId: this.userId,
          sessionKey,
          contentParts: Array.isArray(message.content) ? message.content : [],
          claimedFilenames: message.filenames,
        });
        chatAttachments = result.chatAttachments;
        workspaceRefs = result.workspaceRefs;
      } catch (err) {
        this.sendToClient(clientWs, {
          type: "error",
          error: {
            code: "attachment_invalid",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      }

      const chatOptions: Record<string, unknown> = {
        agentId: message.agentId,
        sessionKey,
      };
      if (chatAttachments.length > 0) {
        chatOptions.attachments = chatAttachments;
      }
      if (message.clientMessageId) {
        chatOptions.clientMessageId = message.clientMessageId;
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
      const uploadHint = buildUploadHint(workspaceRefs);
      if (uploadHint) {
        extraPromptParts.push(uploadHint);
      }
      if (extraPromptParts.length > 0) {
        chatOptions.extraSystemPrompt = extraPromptParts.join("\n\n");
      }

      // Audit each uploaded attachment
      for (const ref of workspaceRefs) {
        const { relativePath, mimeType, sizeBytes } = ref;
        const filename = relativePath.replace(/^uploads\//, "");
        const auditEntry = {
          actorType: "user" as const,
          actorId: this.userId,
          eventType: "attachment.uploaded" as const,
          resource: message.agentId,
          outcome: "success" as const,
          detail: {
            agent: { id: agent.id, name: agent.name },
            attachment: { filename, detectedMimeType: mimeType, sizeBytes },
            sessionKey,
            uploaderUserId: this.userId,
          },
        };
        try {
          await appendAuditLog(auditEntry);
        } catch (err) {
          recordAuditFailure(err, auditEntry);
        }
      }

      if (message.isRetry) {
        // Validate retryReason at the trust boundary. The TypeScript union is
        // erased at runtime, so a malicious or buggy client could otherwise
        // write arbitrary strings into HMAC-signed audit rows.
        const reason: RetryReason = ALLOWED_RETRY_REASONS.has(message.retryReason ?? "")
          ? (message.retryReason as RetryReason)
          : "send_failure";
        // Best-effort audit: a transient DB failure must not fail the chat
        // retry the user explicitly asked for. recordAuditFailure() emits
        // the structured signal so the gap stays observable.
        const auditEntry = {
          actorType: "user" as const,
          actorId: this.userId,
          eventType: "chat.retry_triggered" as const,
          resource: `agent:${message.agentId}`,
          detail: {
            agent: { id: agent.id, name: agent.name },
            sessionKey,
            reason,
          },
          outcome: "success" as const,
        };
        try {
          await appendAuditLog(auditEntry);
        } catch (err) {
          recordAuditFailure(err, auditEntry);
        }
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

      await this.pipeStream(clientWs, stream, agent, sessionKey, messageId);
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
    agent: { id: string; greetingMessage: string }
  ): Promise<void> {
    const sessionKey = this.computeSessionKey(agent.id);

    const fetchAndParseHistory = async () => {
      const result = (await this.openclawClient.sessions.history(sessionKey)) as {
        messages?: HistoryMessage[];
      };
      const rawMessages = result?.messages ?? [];

      // OpenClaw marks user messages that arrived while another turn was still
      // active with this prefix and aggregates them with timestamp annotations.
      // For our retry flow these are duplicates of the original user turn that
      // is already in history, so they're filtered out before reaching the UI.
      const QUEUED_RETRY_PREFIX =
        "[Queued user message that arrived while the previous turn was still active]";

      return rawMessages
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
            rawContent:
              typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content
                      .filter(
                        (part: { type: string; text?: string }) => part.type === "text" && part.text
                      )
                      .map((part: { text?: string }) => part.text!)
                      .join(" ")
                  : "",
            timestamp: msg.timestamp,
          };
        })
        .filter((msg) => msg.content)
        .filter((msg) => !(msg.role === "user" && msg.rawContent.startsWith(QUEUED_RETRY_PREFIX)))
        .map(({ role, content, timestamp }) => ({ role, content, timestamp }));
    };

    const sendGreeting = async () => {
      const greeting = await this.getPersonalizedGreeting(agent.greetingMessage);
      this.sendToClient(clientWs, {
        type: "history",
        messages: [{ role: "assistant", content: greeting }],
      });
    };

    // Tracks whether this session is known to exist (from cache or live check).
    // When true and history is temporarily unavailable (e.g. during an OpenClaw
    // restart), we send an empty history instead of a greeting so the client
    // preserves its existing messages rather than replacing them with a greeting.
    let sessionKnown = false;

    try {
      await this.waitForConnection();

      // Always fetch history directly from OpenClaw — the session cache
      // can miss sessions (e.g. after agent switching or timing gaps)
      let messages = await fetchAndParseHistory();

      if (messages.length === 0) {
        // Determine whether to retry. The cache may be empty after a Pinchy restart
        // (seedSessionCache races with this request), so fall back to a live check
        // via sessions.list() when the cache is cold.
        sessionKnown = this.sessionCache.has(sessionKey);

        if (!sessionKnown) {
          try {
            const listResult = (await this.openclawClient.sessions.list()) as {
              sessions?: { key: string }[];
            };
            const sessions = listResult?.sessions ?? [];
            this.sessionCache.refresh(sessions);
            sessionKnown = this.sessionCache.has(sessionKey);
          } catch {
            // sessions.list() failed — proceed without retry
          }
        }

        // If session is confirmed (via cache or live check), retry once after a
        // brief delay in case OpenClaw just restarted and hasn't re-indexed yet.
        if (sessionKnown) {
          await new Promise((r) => setTimeout(r, 2000));
          messages = await fetchAndParseHistory();
        }
      }

      if (messages.length > 0) {
        this.sessionCache.add(sessionKey);
        this.sendToClient(clientWs, { type: "history", messages });
      } else if (sessionKnown) {
        // Session exists but history is temporarily unavailable (e.g. during an
        // OpenClaw restart). Signal the client so it can retry rather than
        // showing a blank chat or replacing existing messages with a greeting.
        this.sendToClient(clientWs, { type: "history", messages: [], sessionKnown: true });
      } else {
        // No session known — show greeting for new conversations
        await sendGreeting();
      }
    } catch {
      // If session was previously known, the error is likely a restart race —
      // retry once, then send empty history (not greeting) so the client keeps
      // its existing messages.
      if (this.sessionCache.has(sessionKey)) {
        let retryMessages: Awaited<ReturnType<typeof fetchAndParseHistory>> = [];
        try {
          await new Promise((r) => setTimeout(r, 2000));
          retryMessages = await fetchAndParseHistory();
        } catch {
          // Retry also failed — session known but history unavailable
        }
        if (retryMessages.length > 0) {
          this.sendToClient(clientWs, { type: "history", messages: retryMessages });
        } else {
          // History unavailable for known session — don't send greeting.
          // Signal the client so it can retry rather than showing a blank chat.
          this.sendToClient(clientWs, { type: "history", messages: [], sessionKnown: true });
        }
        return;
      }
      if (!this.openclawClient.isConnected) {
        this.sendToClient(clientWs, { type: "history", messages: [] });
        return;
      }
      await sendGreeting();
    }
  }

  // Shared streaming loop used by handleMessage. Handles heartbeat, chunk
  // routing (text/error/done/userMessagePersisted), and the terminal "complete"
  // frame. The loop drains the OpenClaw stream to its natural end regardless
  // of browser WS state — Pinchy-side accounting (sessionCache, messageId
  // rotation) always runs; consumer-bound frames are gated by readyState so
  // we don't write to a closed socket. This makes the assistant reply
  // deterministically present in OpenClaw's session.jsonl by the time the
  // user reconnects (issue #199 Layer B).
  private async pipeStream(
    clientWs: WebSocket,
    stream: AsyncIterable<ChatChunk>,
    agent: { id: string; name: string; model?: string | null },
    sessionKey: string,
    initialMessageId: string
  ): Promise<void> {
    let messageId = initialMessageId;

    // Heartbeat is intentionally deferred until the first chunk arrives.
    // Starting it immediately would reset the client-side stuck timer even
    // when OpenClaw's stream hangs before producing any output (e.g. after a
    // restart), trapping the user in an infinite spinner. Once the first
    // chunk arrives we know OpenClaw is actively responding, so heartbeats
    // are safe to send between turns.
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    try {
      for await (const chunk of stream) {
        // Lazily start the keep-alive heartbeat on the first chunk. The
        // interval callback already self-guards with readyState === WS_OPEN,
        // so a heartbeat to a closed WS is a no-op until the finally block
        // clears it.
        if (heartbeatInterval === null) {
          heartbeatInterval = setInterval(() => {
            if (clientWs.readyState === WS_OPEN) {
              this.sendToClient(clientWs, { type: "thinking", messageId });
            }
          }, THINKING_HEARTBEAT_MS);
        }

        // Pinchy-side accounting — runs regardless of consumer state. The
        // browser may have navigated away, but OpenClaw is still streaming
        // and persisting on its side; our local view of the session
        // (sessionCache, per-turn messageId rotation) must keep up so the
        // next history fetch / WS reconnect sees a coherent state.
        // Note: errored turns intentionally do NOT update the cache — only
        // turns that reach a `done` chunk count as completed sessions.
        if (chunk.type === "done") {
          this.sessionCache.add(sessionKey);
        }

        // Server-side error logging — unconditional. With the drain-always
        // loop, error chunks arriving after the browser navigates away are
        // exactly the chunks operators most need to see (no UI to surface
        // them). Gating this on readyState would silently swallow upstream
        // failures during nav-aways.
        if (chunk.type === "error") {
          console.error("OpenClaw error chunk:", chunk.text);
        }

        // Consumer forwarding — only meaningful while the browser WS is open.
        if (clientWs.readyState === WS_OPEN) {
          if (chunk.type === "userMessagePersisted") {
            this.sendToClient(clientWs, {
              type: "ack",
              clientMessageId: chunk.clientMessageId,
            });
          } else if (chunk.type === "text") {
            const cleaned = chunk.text.replace(/<\/?final>/g, "");
            if (cleaned) {
              this.sendToClient(clientWs, { type: "chunk", content: cleaned, messageId });
            }
          } else if (chunk.type === "error") {
            const modelUnavailable = classifyModelError(chunk.text, agent.model ?? "");
            this.sendToClient(clientWs, {
              type: "error",
              agentName: agent.name,
              providerError: chunk.text,
              hint: getErrorHint(chunk.text, this.userRole),
              messageId,
              ...(modelUnavailable ? { modelUnavailable } : {}),
            });
            if (modelUnavailable && shouldEmitModelUnavailableAudit(agent.id, agent.model ?? "")) {
              // PII note: `chunk.text` is the raw provider error string. For
              // 5xx upstream failures (the only branch we audit here) the
              // server failed before processing the request body, so it
              // generally returns a generic error envelope without echoing
              // the user's prompt. If a future provider starts including
              // request fragments in 5xx error bodies, redact here before
              // appending to the audit trail. AGENTS.md §"Audit logging
              // rules" forbids plaintext PII in audit `detail`.
              const auditEntry = {
                actorType: "user" as const,
                actorId: this.userId,
                eventType: "agent.model_unavailable" as const,
                resource: `agent:${agent.id}`,
                detail: {
                  agent: { id: agent.id, name: agent.name },
                  model: agent.model,
                  providerError: chunk.text.slice(0, 1024),
                  ...(modelUnavailable.ref ? { ref: modelUnavailable.ref } : {}),
                  httpStatus: modelUnavailable.httpStatus,
                },
                outcome: "failure" as const,
              };
              try {
                await appendAuditLog(auditEntry);
              } catch (err) {
                recordAuditFailure(err, auditEntry);
              }
            }
          } else if (chunk.type === "done") {
            this.sendToClient(clientWs, { type: "done", messageId });
          }
        }

        // Per-turn messageId rotation — runs after the optional `done`
        // forwarding so the next agent turn starts with a fresh id whether
        // or not the browser is listening (consistent with how OpenClaw
        // stores them in history).
        if (chunk.type === "done") {
          messageId = crypto.randomUUID();
        }
      }

      // Tell the client the entire request is finished. Unlike "done" events
      // (which fire between agent turns) this is sent exactly once after the
      // iterator is exhausted, so the UI can confidently turn off the
      // thinking indicator only when no more chunks will arrive.
      // No messageId — this terminator is not tied to any specific turn.
      // Skip if the consumer is gone — they'll get the natural state via
      // history on reconnect.
      if (clientWs.readyState === WS_OPEN) {
        this.sendToClient(clientWs, { type: "complete" });
      }
    } finally {
      if (heartbeatInterval !== null) {
        clearInterval(heartbeatInterval);
      }
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

  private async getPersonalizedGreeting(rawGreeting: string): Promise<string> {
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
