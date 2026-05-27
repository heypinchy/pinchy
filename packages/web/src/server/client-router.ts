import type { OpenClawClient, ChatAttachment, ChatChunk, ChatOptions } from "openclaw-node";
import { chatWithDispatchRaceRetry } from "@/server/chat-dispatch-retry";
import type { WebSocket } from "ws";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { isEnterprise } from "@/lib/enterprise";
import { appendAuditLog, safeProviderError } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { ActiveRuns } from "@/server/active-runs";
import {
  shouldEmitModelUnavailableAudit,
  shouldEmitSilentStreamAudit,
  shouldEmitUpstreamFormatErrorAudit,
} from "@/server/model-unavailable-throttle";
import { SessionCache } from "@/server/session-cache";
import { getErrorHint } from "@/server/error-hints";
import { classifyModelError, classifyUpstreamFormatError } from "@/server/model-error-classifier";
import {
  classifyAgentError,
  classifySynthesisedError,
  type AgentErrorClass,
} from "@/server/agent-error-classifier";
import {
  SILENT_REPLY_TOKEN,
  safeEmitLength,
  stripFinalEnvelope,
} from "@/server/silent-reply-buffer";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  type ContentPart,
  type ProcessedWorkspaceRef,
  buildAttachmentBlock,
  parseAttachmentBlock,
  processIncomingAttachments,
  UploadValidationError,
} from "@/server/attachment-pipeline";

const WS_OPEN = 1;
const CONNECTION_TIMEOUT_MS = 10_000;
// Browsers and intermediate proxies close idle WebSockets after ~30-60s of
// silence. While the agent is in a slow tool-use loop (e.g. local Ollama
// thinking for >60s between turns), the server must keep the socket alive
// with periodic frames. We send a "thinking" heartbeat every 15s — frequent
// enough to defeat any reasonable idle timer, sparse enough not to spam.
const THINKING_HEARTBEAT_MS = 15_000;

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

export class ClientRouter {
  constructor(
    private openclawClient: OpenClawClient,
    private userId: string,
    private userRole: string,
    private sessionCache: SessionCache,
    /**
     * Server-wide registry of in-flight chat runs (#310 Tier 2). Optional
     * for backward compatibility with tests that pre-date Tier 2a — those
     * get a per-router instance, which is fine because they don't run the
     * watchdog and don't share state across ClientRouter instances anyway.
     * Production wires the singleton from `active-runs-singleton.ts`.
     */
    private activeRuns: ActiveRuns = new ActiveRuns()
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
          contentParts: Array.isArray(message.content) ? message.content : [],
          claimedFilenames: message.filenames,
        });
        chatAttachments = result.chatAttachments;
        workspaceRefs = result.workspaceRefs;
      } catch (err) {
        // Validation errors are caused by client input and are safe to surface
        // verbatim ("File type mismatch", "Filename too long", etc.). Anything
        // else is an internal failure (filesystem error, programmer mistake)
        // that must NOT leak to the client — log it server-side and return a
        // generic message.
        if (err instanceof UploadValidationError) {
          this.sendToClient(clientWs, {
            type: "error",
            code: "attachment_invalid",
            message: err.message,
          });
        } else {
          console.error("[client-router] attachment processing failed:", err);
          this.sendToClient(clientWs, {
            type: "error",
            code: "attachment_invalid",
            message: "Could not process attachment. Please try again.",
          });
        }
        return;
      }

      const chatOptions: Record<string, unknown> = {
        agentId: message.agentId,
        sessionKey,
      };
      // Forward the agent's configured provider/model so OpenClaw's `agent`
      // RPC resolves capability checks (notably image-input support) against
      // the right model. Without this, server-methods falls back to the
      // gateway-wide default model — see #324 / openclaw-node 0.9.0.
      // Split on the FIRST '/' only: provider is before, model is the
      // rest (model ids can themselves contain '/', e.g. HuggingFace).
      if (agent.model) {
        const slashIdx = agent.model.indexOf("/");
        if (slashIdx > 0 && slashIdx < agent.model.length - 1) {
          chatOptions.provider = agent.model.slice(0, slashIdx);
          chatOptions.model = agent.model.slice(slashIdx + 1);
        }
      }
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
      if (extraPromptParts.length > 0) {
        chatOptions.extraSystemPrompt = extraPromptParts.join("\n\n");
      }

      // Embed the attachment block in the *user message text*, not the system
      // prompt. OpenClaw persists the user message into its session JSONL but
      // rebuilds the system prompt on every turn, so a system-prompt-side hint
      // is invisible when the agent reads its own history. Embedding the file
      // ↔ turn mapping in the message itself keeps it visible per-turn AND
      // lets the history-load path round-trip the metadata into chip rendering
      // (see parseAttachmentBlock + handleHistory below).
      const attachmentBlock = buildAttachmentBlock(workspaceRefs);
      if (attachmentBlock) {
        text = text.length > 0 ? `${text}\n\n${attachmentBlock}` : attachmentBlock;
      }

      // Audit each uploaded attachment. AGENTS.md requires {id, name} pairs
      // for both the resource (agent) and the actor (uploader); a name-less
      // user-id row is harder to read months later when the user record may
      // have been renamed or deleted.
      //
      // Fallback is `<unknown user>` (not the UUID) so audit readers can tell
      // at a glance that the name is synthetic. Writing the UUID into a
      // `name` field would be indistinguishable from a legitimate (if odd)
      // human name and silently degrade audit-log readability.
      const uploaderRef = { id: this.userId, name: user?.name ?? "<unknown user>" };
      for (const ref of workspaceRefs) {
        const { relativePath, mimeType, sizeBytes, contentHash, reused } = ref;
        const filename = relativePath.replace(/^uploads\//, "");
        const auditEntry = {
          actorType: "user" as const,
          actorId: this.userId,
          eventType: "attachment.uploaded" as const,
          resource: `agent:${message.agentId}`,
          outcome: "success" as const,
          detail: {
            agent: { id: agent.id, name: agent.name },
            uploader: uploaderRef,
            attachment: { filename, detectedMimeType: mimeType, sizeBytes, contentHash, reused },
            sessionKey,
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

      // Diagnostic for #310 / PR #442 Domain Lock investigation. Gated
      // behind PINCHY_E2E_CHAT_TRACE so it doesn't ship to production logs.
      // The integration test stack sets this env in docker-compose.integration.yml.
      if (process.env.PINCHY_E2E_CHAT_TRACE === "1") {
        console.log(
          `[trace:chat] dispatch agent=${agent.id} session=${sessionKey} ` +
            `text-len=${text.length} attachments=${chatAttachments.length}`
        );
      }

      // Wrap the raw `openclawClient.chat()` stream in a single-shot retry
      // for OpenClaw 2026.5.x's `config.get` vs agent-RPC dispatch race:
      // immediately after a `config.apply` that adds an agent, OC's
      // dispatch handler can still reject the same id with
      // `unknown agent id` while `config.get` already reports it as
      // present. The wrapper swallows the transient first-chunk error,
      // waits 500 ms, and restarts the chat once — transparently to the
      // rest of `pipeStream`. See `chat-dispatch-retry.ts` for the full
      // rationale (and PR #442 CI runs 26505503327 / 26511658136 for the
      // observed failure mode that motivated this).
      const stream = chatWithDispatchRaceRetry(text, chatOptions as ChatOptions, {
        chat: (m, o) => this.openclawClient.chat(m, o),
        onDispatchRaceObserved: async ({ providerError }) => {
          // Audit the transient observation so we can measure how often
          // the dispatch race fires in production without relying on
          // anecdotal log-grep. Using `chat.agent_error` with the
          // existing `provider_config` class would muddy the per-class
          // dashboards built off issue #355; instead we route through
          // the umbrella event with a `retried: true` flag so a follow-up
          // dedicated event type (e.g. `chat.agent_dispatch_race`) can be
          // added later without rewriting historical rows.
          await this.writeAgentErrorAudit({
            agent,
            errorClass: classifyAgentError(providerError),
            providerError,
            retried: true,
          });
        },
      });

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

    // #310 Tier 2b: re-attach this ws to the appropriate listener set
    // BEFORE the history send so any chunks arriving during the await
    // below still reach the reconnecting browser. Detach from every
    // prior chat first — a single tab that switches agents must NOT
    // keep receiving the old chat's stream.
    this.activeRuns.removeListenerFromAll(clientWs);
    const activeRun = this.activeRuns.get(sessionKey);
    if (activeRun) {
      this.activeRuns.addListener(sessionKey, clientWs);
    }
    // Signal embedded in every history response variant so the client
    // can preserve `isRunning=true` and anchor incoming chunks to the
    // right message id after reconcile.
    const activeRunSignal = activeRun
      ? {
          runId: activeRun.runId,
          messageId: activeRun.currentMessageId,
          startedAt: activeRun.startedAt,
        }
      : undefined;

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

      return (
        rawMessages
          .filter((msg) => msg.role === "user" || msg.role === "assistant")
          .map((msg) => {
            let content: string;
            if (Array.isArray(msg.content)) {
              content = msg.content
                .filter(
                  (part: { type: string; text?: string }) => part.type === "text" && part.text
                )
                .map((part: { text?: string }) => part.text!)
                .join(" ");
            } else {
              content = typeof msg.content === "string" ? msg.content : "";
            }

            // Strip protocol tags from assistant responses
            content = content.replace(/<\/?final>/g, "");

            // For user messages: strip OpenClaw's timestamp prefix AND extract
            // the per-message <pinchy:attachments> block (see buildAttachmentBlock
            // in attachment-pipeline.ts). The block lives in the message text in
            // OpenClaw's session JSONL — we round-trip its metadata into the
            // wire-level `files` field so the browser can render the chip
            // without ever seeing the markup.
            let files: Array<{ filename: string; mimeType: string }> | undefined;
            if (msg.role === "user") {
              content = content.replace(/^\[.*?\]\s*/, "");
              const parsed = parseAttachmentBlock(content);
              content = parsed.cleanText;
              if (parsed.attachments.length > 0) {
                files = parsed.attachments.map((a) => ({
                  filename: a.filename,
                  mimeType: a.mimeType,
                }));
              }
            }

            return {
              role: msg.role as "user" | "assistant",
              content,
              files,
              rawContent:
                typeof msg.content === "string"
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content
                        .filter(
                          (part: { type: string; text?: string }) =>
                            part.type === "text" && part.text
                        )
                        .map((part: { text?: string }) => part.text!)
                        .join(" ")
                    : "",
              timestamp: msg.timestamp,
            };
          })
          // Keep messages that have either text content OR a non-empty `files`
          // chip list. Attachment-only user messages (PDF dropped without any
          // accompanying prose) round-trip to `content === ""` after the block
          // is stripped — dropping them here would silently delete the user's
          // own upload from history. The chip's `files` metadata is the carrier
          // of meaning in that case, so it must be enough on its own.
          .filter((msg) => msg.content || (msg.files && msg.files.length > 0))
          .filter((msg) => !(msg.role === "user" && msg.rawContent.startsWith(QUEUED_RETRY_PREFIX)))
          .map(({ role, content, files, timestamp }) => ({ role, content, files, timestamp }))
      );
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
        this.sendToClient(clientWs, {
          type: "history",
          messages,
          ...(activeRunSignal ? { activeRun: activeRunSignal } : {}),
        });
      } else if (sessionKnown) {
        // Session exists but history is temporarily unavailable (e.g. during an
        // OpenClaw restart). Signal the client so it can retry rather than
        // showing a blank chat or replacing existing messages with a greeting.
        this.sendToClient(clientWs, {
          type: "history",
          messages: [],
          sessionKnown: true,
          ...(activeRunSignal ? { activeRun: activeRunSignal } : {}),
        });
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
          this.sendToClient(clientWs, {
            type: "history",
            messages: retryMessages,
            ...(activeRunSignal ? { activeRun: activeRunSignal } : {}),
          });
        } else {
          // History unavailable for known session — don't send greeting.
          // Signal the client so it can retry rather than showing a blank chat.
          this.sendToClient(clientWs, {
            type: "history",
            messages: [],
            sessionKnown: true,
            ...(activeRunSignal ? { activeRun: activeRunSignal } : {}),
          });
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

    // Per-turn rolling buffer for text chunks. We hold back any tail that
    // could still grow into a SILENT_REPLY_TOKEN, then either flush or
    // suppress it when the turn ends.
    let textBuffer = "";

    // Safety net for issue #320: OpenClaw's embedded runner falls through to
    // `continue_normal` when `surface_error` fires with `params.timedOut`,
    // emitting no lifecycle error event. The stream ends silently and the
    // user is left with no error bubble and no retry button. We track
    // whether any consumer-visible output reached the client and synthesize
    // an error frame if the stream ends with nothing visible. Heartbeats
    // and lifecycle/tool chunks don't count — only text the user would see
    // or an explicit error chunk closes the safety net.
    let sawText = false;
    let sawError = false;

    // Heartbeat is intentionally deferred until the first chunk arrives.
    // Starting it immediately would reset the client-side stuck timer even
    // when OpenClaw's stream hangs before producing any output (e.g. after a
    // restart), trapping the user in an infinite spinner. Once the first
    // chunk arrives we know OpenClaw is actively responding, so heartbeats
    // are safe to send between turns.
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    // #310 Tier 2a: track this run in `activeRuns` so the watchdog can
    // see it and so chunks arriving after the browser disconnect still
    // attribute to a known server-side record. Registration is lazy —
    // we don't have the runId until the first event arrives — and
    // strictly idempotent (only the first registering chunk creates an
    // entry). `sawTerminalError` distinguishes "stream ended with no
    // listeners" (= audit chat.run_completed_after_disconnect) from
    // "stream errored and no one was watching" (= just clean up).
    let activeRunRegistered = false;
    let activeRunId: string | undefined;
    let sawTerminalError = false;

    try {
      for await (const chunk of stream) {
        // Lazily start the keep-alive heartbeat on the first chunk.
        //
        // For client-originated messages (always have a `clientMessageId`)
        // the first chunk IS `userMessagePersisted` — OC's `accepted`
        // response that confirms the run is queued. That's the earliest
        // possible signal it's safe to fire heartbeats: starting before
        // accepted would mask a Gateway that hangs at request-receive
        // time, but starting on accepted catches the slow-first-token
        // case where OC is busy and the model takes >60s to emit any
        // text. See #310 Tier 2c.
        //
        // For server-originated messages without a clientMessageId
        // (cron jobs, webhooks) the first chunk falls back to
        // `agent_start` or text — same heartbeat-safe property holds.
        if (heartbeatInterval === null) {
          heartbeatInterval = setInterval(() => {
            // Tier 2b: heartbeats broadcast to every listener so a tab that
            // joined via reconnect-resume keeps its "thinking" indicator
            // alive across the silent windows of slow tool-use loops.
            this.broadcastForRun(sessionKey, clientWs, { type: "thinking", messageId });
          }, THINKING_HEARTBEAT_MS);
        }

        // Tier 2a: lazy registration on the first chunk that carries a
        // runId, then a touch on every subsequent chunk. Both run BEFORE
        // existing chunk handling so a thrown error in the existing block
        // still leaves the registry up-to-date for the finally cleanup.
        if (!activeRunRegistered && chunk.runId) {
          this.activeRuns.register({
            runId: chunk.runId,
            sessionKey,
            agentId: agent.id,
            userId: this.userId,
            agentName: agent.name,
            startedAt: Date.now(),
            currentMessageId: messageId,
            ws: clientWs,
          });
          activeRunRegistered = true;
          activeRunId = chunk.runId;
          if (process.env.PINCHY_E2E_CHAT_TRACE === "1") {
            console.log(
              `[trace:chat] first-chunk session=${sessionKey} runId=${chunk.runId} ` +
                `ws-state=${clientWs.readyState} chunk-type=${chunk.type}`
            );
          }
        } else if (activeRunRegistered) {
          this.activeRuns.touch(sessionKey, Date.now());
        }
        if (chunk.type === "error") {
          sawTerminalError = true;
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

          // Issue #355: universal `chat.agent_error` audit. Fires for every
          // error chunk regardless of clientWs state and regardless of
          // whether a more specialised event (agent.model_unavailable,
          // agent.upstream_format_error, chat.silent_stream further below)
          // also fires. The specialised events stay in their role as
          // throttled operational signals with richer per-class detail; this
          // umbrella exists so a single query grouped by `errorClass` covers
          // every failure shape — including the long tail (FailoverError
          // incomplete-stream, unclassified) that currently has no audit
          // signal at all.
          //
          // PII note: same reasoning as the existing model_unavailable
          // branch — provider error envelopes don't echo user prompt text on
          // these failures. Truncated to 1024 bytes as a belt-and-braces.
          //
          // Ordering: the audit `await` runs BEFORE the consumer-forwarding
          // block below. Intentional — the audit row must land before any
          // browser-facing side effect so that a forwarding-related throw
          // (closed WS, send error) can't lose the audit trail. This is
          // safe because exactly one error chunk arrives per failed stream
          // (the stream terminates after it), so the await runs at most
          // once per failed request — not on a hot per-chunk path.
          await this.writeAgentErrorAudit({
            agent,
            errorClass: classifyAgentError(chunk.text),
            providerError: chunk.text,
          });
        }

        // Consumer forwarding — always runs the state-tracking (sawText,
        // sawError, textBuffer) so the silent-stream safety net stays
        // correct, then broadcasts to every ws in the listener set
        // (Tier 2b). `broadcastForRun` falls back to the originating ws
        // when no run is registered (e.g. pre-first-chunk frames) and
        // per-listener readyState-gates internally.
        {
          if (chunk.type === "userMessagePersisted") {
            this.broadcastForRun(sessionKey, clientWs, {
              type: "ack",
              clientMessageId: chunk.clientMessageId,
            });
          } else if (chunk.type === "text") {
            sawText = true;
            textBuffer = stripFinalEnvelope(textBuffer + chunk.text);
            const safeLen = safeEmitLength(textBuffer);
            if (safeLen > 0) {
              const emit = textBuffer.slice(0, safeLen);
              textBuffer = textBuffer.slice(safeLen);
              this.broadcastForRun(sessionKey, clientWs, {
                type: "chunk",
                content: emit,
                messageId,
              });
            }
          } else if (chunk.type === "error") {
            sawError = true;
            const modelUnavailable = classifyModelError(chunk.text, agent.model ?? "");
            // Issue #338: detect upstream schema/format rejections (e.g. Gemini 3
            // missing `thought_signature` on tool-call replay) so the user sees a
            // bubble explaining that retry usually works, instead of the
            // misleading generic provider-error wording. Orthogonal to
            // modelUnavailable: that one fires on 5xx, this one on 400 schema
            // rejection, and the same chunk should never match both.
            const upstreamFormatError = classifyUpstreamFormatError(chunk.text, agent.model ?? "");
            this.broadcastForRun(sessionKey, clientWs, {
              type: "error",
              agentName: agent.name,
              providerError: chunk.text,
              hint: getErrorHint(chunk.text, this.userRole),
              messageId,
              ...(modelUnavailable ? { modelUnavailable } : {}),
              ...(upstreamFormatError ? { upstreamFormatError } : {}),
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
                  providerError: safeProviderError(chunk.text),
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
            if (
              upstreamFormatError &&
              shouldEmitUpstreamFormatErrorAudit(agent.id, agent.model ?? "")
            ) {
              // PII note: same reasoning as the model_unavailable branch above.
              // The thought_signature 400 originates inside the provider's
              // schema validator before any tool call is dispatched; the
              // returned body echoes the offending field name, not user prompt
              // text. Still truncated to 1024 bytes as a safety belt.
              const auditEntry = {
                actorType: "user" as const,
                actorId: this.userId,
                eventType: "agent.upstream_format_error" as const,
                resource: `agent:${agent.id}`,
                detail: {
                  agent: { id: agent.id, name: agent.name },
                  model: agent.model,
                  providerError: safeProviderError(chunk.text),
                  errorPattern: upstreamFormatError.errorPattern,
                  ...(upstreamFormatError.ref ? { ref: upstreamFormatError.ref } : {}),
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
            // Flush remaining buffer at end-of-turn. If the entire turn
            // resolved to the silent-reply sentinel, suppress it; otherwise
            // emit whatever text was held back.
            if (textBuffer && textBuffer !== SILENT_REPLY_TOKEN) {
              this.broadcastForRun(sessionKey, clientWs, {
                type: "chunk",
                content: textBuffer,
                messageId,
              });
            }
            this.broadcastForRun(sessionKey, clientWs, { type: "done", messageId });
          }
        }

        // Per-turn messageId rotation — runs after the optional `done`
        // forwarding so the next agent turn starts with a fresh id whether
        // or not the browser is listening (consistent with how OpenClaw
        // stores them in history).
        if (chunk.type === "done") {
          textBuffer = "";
          messageId = crypto.randomUUID();
          // Tier 2b: keep the registry's view of the current messageId in
          // sync with the per-turn rotation so a reconnecting client gets
          // an `activeRun.messageId` that anchors incoming chunks to the
          // right message after history reconcile.
          if (activeRunRegistered) {
            this.activeRuns.updateMessageId(sessionKey, messageId);
          }
        }
      }

      // Issue #320 safety net: stream ended without any consumer-visible
      // output. Surface a retry-able error so the user isn't stranded with
      // an empty assistant turn (most likely cause: OC's embedded runner
      // swallowed a `surface_error reason=timeout` into `continue_normal`).
      // Must precede the `complete` frame so the client's error handler
      // runs before the spinner is cleared.
      if (!sawText && !sawError) {
        const providerError = "The model did not produce a response. It may have timed out.";
        // Tier 2b: broadcast so a tab joined via reconnect-resume also
        // sees the synthesised error (the original ws might already be
        // gone). The listener-set fallback inside broadcastForRun reaches
        // the originating ws when no run is registered, e.g. if the OC
        // stream produced zero chunks at all.
        this.broadcastForRun(sessionKey, clientWs, {
          type: "error",
          agentName: agent.name,
          providerError,
          hint: getErrorHint(providerError, this.userRole),
          messageId,
        });

        // Issue #355: umbrella `chat.agent_error` for the silent-stream
        // synthesised error too, so the universal measurement signal
        // captures this class alongside the throttled `chat.silent_stream`
        // operational signal below. Routed through `classifySynthesisedError`
        // so adding a future synthesised-error site is a compile error in
        // the classifier rather than a silent gap in audit coverage.
        await this.writeAgentErrorAudit({
          agent,
          errorClass: classifySynthesisedError("silent_stream"),
          providerError,
        });

        // Operational signal: a silent timeout shouldn't be invisible to
        // admins reviewing the audit trail. Throttled per (agentId, model)
        // so a degraded provider can't flood the log via user retries.
        if (shouldEmitSilentStreamAudit(agent.id, agent.model ?? "")) {
          const auditEntry = {
            actorType: "user" as const,
            actorId: this.userId,
            eventType: "chat.silent_stream" as const,
            resource: `agent:${agent.id}`,
            detail: {
              agent: { id: agent.id, name: agent.name },
              model: agent.model ?? null,
              // safeProviderError is a no-op on the synthesised Pinchy
              // string today (no email, fits under 1024 bytes), but
              // routing every providerError through the same helper
              // means future refactors that change the synthesised text
              // can't silently regress the audit-PII contract.
              providerError: safeProviderError(providerError),
              reason: "silent_stream_end" as const,
            },
            outcome: "failure" as const,
          };
          try {
            await appendAuditLog(auditEntry);
          } catch (err) {
            recordAuditFailure(err, auditEntry);
          }
        }
      }

      // Tell the client the entire request is finished. Unlike "done" events
      // (which fire between agent turns) this is sent exactly once after the
      // iterator is exhausted, so the UI can confidently turn off the
      // thinking indicator only when no more chunks will arrive.
      // No messageId — this terminator is not tied to any specific turn.
      // Tier 2b broadcasts so any tab that joined via reconnect-resume gets
      // the terminator too; broadcastForRun reaches the originating ws if
      // no listener set exists.
      this.broadcastForRun(sessionKey, clientWs, { type: "complete" });
    } finally {
      // #310 Tier 2a: clean up the registry entry and, if the run finished
      // normally but with zero listeners, write a chat.run_completed_after_disconnect
      // audit row so operators can see "this run completed for a browser
      // session that had already gone away". A terminated error path
      // (sawTerminalError === true) doesn't get this audit — that's
      // covered by the existing chat.agent_error / classified events.
      if (activeRunRegistered) {
        const run = this.activeRuns.get(sessionKey);
        if (run && run.listeners.size === 0 && !sawTerminalError) {
          const auditEntry = {
            actorType: "user" as const,
            actorId: this.userId,
            eventType: "chat.run_completed_after_disconnect" as const,
            resource: `agent:${agent.id}`,
            detail: {
              agent: { id: agent.id, name: agent.name },
              user: { id: this.userId },
              sessionKey,
              runId: activeRunId!,
            },
            outcome: "success" as const,
          };
          try {
            await appendAuditLog(auditEntry);
          } catch (err) {
            recordAuditFailure(err, auditEntry);
          }
        }
        this.activeRuns.delete(sessionKey);
      }
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

  /**
   * Tier 2b broadcast: send a frame to every ws currently listening on the
   * given run. If no run is registered for `sessionKey` (e.g. pre-first-
   * chunk frames like the initial "thinking" or a complete frame after the
   * run was already cleaned up in the finally block), fall back to the
   * originating ws — that preserves backward compatibility with the
   * pre-Tier-2b single-ws flow without leaving any path silently dropped.
   *
   * Each listener is independently readyState-gated so a half-closed
   * socket can't poison the broadcast for the others.
   */
  private broadcastForRun(
    sessionKey: string,
    fallbackWs: WebSocket,
    data: Record<string, unknown>
  ): void {
    const run = this.activeRuns.get(sessionKey);
    if (!run || run.listeners.size === 0) {
      this.sendToClient(fallbackWs, data);
      return;
    }
    const payload = JSON.stringify(data);
    for (const ws of run.listeners) {
      if (ws.readyState === WS_OPEN) ws.send(payload);
    }
  }

  /**
   * Write the `chat.agent_error` umbrella audit row (issue #355).
   *
   * Universal measurement signal: fires for every error chunk that reaches
   * the chat WS error surface, plus the silent-stream synthesised error.
   * Specialised events (agent.model_unavailable, agent.upstream_format_error,
   * chat.silent_stream) remain in their role as throttled operational
   * signals; this umbrella exists so a single query grouped by errorClass
   * captures every failure shape, including the long tail.
   *
   * Called from WebSocket handler scope (not Next request scope), so uses
   * the appendAuditLog + recordAuditFailure pattern per audit-deferred.ts.
   *
   * The call site `await`s this against forwarding to the browser. That's
   * deliberate, not an oversight: the AGENTS.md rule forbids fire-and-forget
   * audit writes, and there is exactly one error chunk per stream (the
   * stream terminates after it), so the audit await runs at most once per
   * failed request — not in a hot loop.
   *
   * PII: `providerError` is routed through `safeProviderError()` from
   * `lib/audit.ts` — single source of truth for "scrub emails, then
   * truncate to 1024 bytes" across every providerError audit field.
   * The umbrella covers the long tail (`errorClass="unknown"`) where
   * we can't pre-validate what providers echo back. The audit table is
   * append-only and HMAC-signed, so GDPR Art. 17 erasure is impossible
   * by design; scrubbing at write time is the only protection.
   */
  private async writeAgentErrorAudit(args: {
    agent: { id: string; name: string; model?: string | null };
    errorClass: AgentErrorClass;
    providerError: string;
    /**
     * Set to true when the error was caught and Pinchy automatically
     * retried — currently only the OC dispatch-race wrapper sets this.
     * Surfaces in `detail.retried` so operator dashboards can filter
     * recoverable from terminal failures without parsing `providerError`.
     */
    retried?: boolean;
  }): Promise<void> {
    const auditEntry = {
      actorType: "user" as const,
      actorId: this.userId,
      eventType: "chat.agent_error" as const,
      resource: `agent:${args.agent.id}`,
      detail: {
        agent: { id: args.agent.id, name: args.agent.name },
        model: args.agent.model ?? null,
        errorClass: args.errorClass,
        providerError: safeProviderError(args.providerError),
        ...(args.retried ? { retried: true } : {}),
      },
      outcome: "failure" as const,
    };
    try {
      await appendAuditLog(auditEntry);
    } catch (err) {
      recordAuditFailure(err, auditEntry);
    }
  }
}
