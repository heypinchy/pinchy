import type {
  OpenClawClient,
  ChatAttachment,
  ChatChunk,
  ChatOptions,
  AgentWaitResult,
} from "openclaw-node";
import { chatWithDispatchRaceRetry } from "@/server/chat-dispatch-retry";
import { waitForAgentInRuntime } from "@/server/agent-readiness";
import type { WebSocket } from "ws";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { getLicenseState } from "@/lib/enterprise";
import { buildMemoryPromptBlock } from "@/lib/memory-prompt";
import { appendAuditLog, safeProviderError } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { ActiveRuns } from "@/server/active-runs";
import { recordSessionTurnsUsage } from "@/lib/usage-per-turn";
import {
  shouldEmitModelUnavailableAudit,
  shouldEmitSilentStreamAudit,
  shouldEmitUpstreamFormatErrorAudit,
} from "@/server/model-unavailable-throttle";
import { SessionCache } from "@/server/session-cache";
import { resolveUserPlaceholder } from "@/server/user-placeholder";
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
import { agents, users, models } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isModelVisionCapable } from "@/lib/model-vision";
import { resolveImageTurnModel, type VisionCandidate } from "@/lib/image-fallback";
import { readExistingConfig } from "@/lib/openclaw-config/write";
import {
  type ProcessedWorkspaceRef,
  buildAttachmentBlock,
  parseAttachmentBlock,
  materializeAttachments,
  AttachmentNotFoundError,
  AttachmentExpiredError,
  AttachmentAlreadyAttachedError,
} from "@/server/attachment-pipeline";
import { attachmentIdsSchema } from "@/lib/schemas/uploads";

const WS_OPEN = 1;
const CONNECTION_TIMEOUT_MS = 10_000;
// Browsers and intermediate proxies close idle WebSockets after ~30-60s of
// silence. While the agent is in a slow tool-use loop (e.g. local Ollama
// thinking for >60s between turns), the server must keep the socket alive
// with periodic frames. We send a "thinking" heartbeat every 15s — frequent
// enough to defeat any reasonable idle timer, sparse enough not to spam.
const THINKING_HEARTBEAT_MS = 15_000;

// How long the reconnect path waits on the gateway's authoritative
// run-liveness oracle (`agentWait`) before giving up on a verdict. Short by
// design: a reconnect must resolve quickly, and `agentWait` returns a
// `pending`/`timeout` result (still alive) rather than throwing when the run
// outlives the window — that's already the "responding" verdict. A throw is an
// infra hiccup, which we deliberately do NOT turn into a `failed` verdict.
const RECONNECT_LIVENESS_TIMEOUT_MS = 5_000;

type RetryReason = "orphan" | "partial_stream_failure" | "send_failure";
const ALLOWED_RETRY_REASONS: ReadonlySet<string> = new Set([
  "orphan",
  "partial_stream_failure",
  "send_failure",
]);

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface ChatMessage {
  type: "message";
  content: string | ContentPart[];
  agentId: string;
  clientMessageId?: string;
  isRetry?: boolean;
  /** Recovery scenario behind a retry — surfaced in the audit log. */
  retryReason?: RetryReason;
  /** Two-phase upload IDs from the staged-upload flow. */
  attachmentIds?: string[];
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

  private computeSessionKey(agentId: string, chatId?: string): string {
    const base = `agent:${agentId}:direct:${this.userId}`;
    return chatId ? `${base}:${chatId}` : base;
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

    const licenseState = await getLicenseState();
    const effVis = effectiveVisibility(agent.visibility, licenseState);
    const needsGroups = this.userRole !== "admin" && effVis === "restricted";

    const [userGroupIds, agentGroupIds] = await Promise.all([
      needsGroups ? getUserGroupIds(this.userId) : Promise.resolve([]),
      needsGroups ? getAgentGroupIds(message.agentId) : Promise.resolve([]),
    ]);

    try {
      assertAgentAccess(
        agent,
        this.userId,
        this.userRole,
        userGroupIds,
        agentGroupIds,
        licenseState
      );
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

    // Reject legacy attachment shape: clients that still send structured content
    // parts with image_url base64 payloads are running outdated code. Do NOT
    // forward to OpenClaw and do NOT write an audit entry — this is a client-side
    // protocol bug, not a state change.
    if (
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url")
    ) {
      this.sendToClient(clientWs, { type: "error", code: "PROTOCOL_OUTDATED" });
      return;
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

      // Materialize staged uploads via the two-phase upload flow.
      let chatAttachments: ChatAttachment[] = [];
      let workspaceRefs: ProcessedWorkspaceRef[] = [];
      if (message.attachmentIds && message.attachmentIds.length > 0) {
        // Validate at the WS trust boundary — clients are bounded to UUIDs and
        // at most 10 attachments per message by attachmentIdsSchema. A frame
        // that breaks either is rejected without touching the DB.
        const parsedIds = attachmentIdsSchema.safeParse(message.attachmentIds);
        if (!parsedIds.success) {
          this.sendToClient(clientWs, {
            type: "error",
            code: "attachment_invalid",
            message: parsedIds.error.issues[0]?.message ?? "Invalid attachmentIds",
          });
          return;
        }
        try {
          const result = await materializeAttachments({
            agentId: message.agentId,
            userId: this.userId,
            attachmentIds: parsedIds.data,
            messageId,
            agentName: agent.name,
          });
          chatAttachments = result.chatAttachments;
          workspaceRefs = result.workspaceRefs;
        } catch (err) {
          if (err instanceof AttachmentNotFoundError) {
            this.sendToClient(clientWs, {
              type: "error",
              code: "attachment_not_found",
              message: err.message,
            });
          } else if (err instanceof AttachmentExpiredError) {
            this.sendToClient(clientWs, {
              type: "error",
              code: "attachment_expired",
              message: err.message,
            });
          } else if (err instanceof AttachmentAlreadyAttachedError) {
            this.sendToClient(clientWs, {
              type: "error",
              code: "attachment_already_attached",
              message: err.message,
            });
          } else {
            console.error("[client-router] attachment materialization failed:", err);
            this.sendToClient(clientWs, {
              type: "error",
              code: "attachment_invalid",
              message: "Could not process attachment. Please try again.",
            });
          }
          return;
        }
      }

      const chatOptions: Record<string, unknown> = {
        agentId: message.agentId,
        sessionKey,
      };

      // Decide which model runs THIS turn. Normally the agent's own model, but an
      // image sent to a text-only agent model is routed to a vision-capable
      // fallback for this turn only — the agent's stored model is untouched and
      // the next text turn resolves straight back to it. We do this because
      // OpenClaw's `agent` RPC throws on image+text-only instead of offloading
      // (the offload path lives only on `chat.send`, which can't carry the
      // `extraSystemPrompt`/`provider`/`model` params Pinchy depends on). Routing
      // the turn keeps per-user context intact and avoids permanently swapping
      // the agent's model the way the old recovery dialog did.
      const turnModel = await resolveImageTurnModel({
        agentModel: agent.model,
        agentUsesTools: ((agent.allowedTools as string[] | null) ?? []).length > 0,
        attachmentMimeTypes: chatAttachments.map((a) => a.mimeType ?? ""),
        deps: {
          modelSupportsVision: isModelVisionCapable,
          listVisionCandidates,
          getGlobalImageModel: getConfiguredImageModel,
        },
      });

      if (turnModel.kind === "blocked") {
        // Image needs vision, the agent's model can't read images, and no
        // image-capable model is configured anywhere to fall back to. Surface a
        // clear, actionable error instead of letting OpenClaw reject the turn —
        // the fix is an admin configuring a vision model, not swapping this
        // agent's model.
        this.sendToClient(clientWs, {
          type: "error",
          code: "vision_unavailable",
          message:
            "This agent's model can't read images, and no image-capable model is configured to handle them. Ask an admin to configure one in Settings.",
        });
        return;
      }

      // Forward the resolved provider/model so OpenClaw's `agent` RPC resolves
      // capability checks (notably image-input support) against the right model.
      // Without this, server-methods falls back to the gateway-wide default model
      // — see #324 / openclaw-node 0.9.0. Split on the FIRST '/' only: provider is
      // before, model is the rest (model ids can themselves contain '/').
      const turnModelRef = turnModel.kind === "fallback" ? turnModel.model : agent.model;
      if (turnModelRef) {
        const slashIdx = turnModelRef.indexOf("/");
        if (slashIdx > 0 && slashIdx < turnModelRef.length - 1) {
          chatOptions.provider = turnModelRef.slice(0, slashIdx);
          chatOptions.model = turnModelRef.slice(slashIdx + 1);
        }
      }

      if (turnModel.kind === "fallback") {
        // Governance: a CISO needs to see that this turn's image went to a model
        // other than the agent's configured one. Non-request (WS) context, so
        // record-on-failure rather than rollback.
        const fallbackAudit = {
          actorType: "user" as const,
          actorId: this.userId,
          eventType: "chat.image_model_fallback" as const,
          resource: `agent:${message.agentId}`,
          detail: {
            agent: { id: agent.id, name: agent.name },
            sessionKey,
            agentModel: agent.model,
            fallbackModel: turnModel.model,
            reason: "text_only_model_received_image",
          },
          outcome: "success" as const,
        };
        try {
          await appendAuditLog(fallbackAudit);
        } catch (err) {
          recordAuditFailure(err, fallbackAudit);
        }
      }

      if (chatAttachments.length > 0) {
        chatOptions.attachments = chatAttachments;
      }
      if (message.clientMessageId) {
        chatOptions.clientMessageId = message.clientMessageId;
      }

      // Build extraSystemPrompt from memory capability + user name + context +
      // greeting. The memory block goes first: it's a stable platform
      // capability, not per-turn context. We inject it here (not AGENTS.md)
      // because it's a capability every write-capable agent has and must not
      // be user-editable — see memory-prompt.ts.
      const extraPromptParts: string[] = [];
      const allowedTools = (agent.allowedTools as string[] | null) ?? [];
      const memoryBlock = buildMemoryPromptBlock(allowedTools);
      if (memoryBlock) {
        extraPromptParts.push(memoryBlock);
      }
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
        const personalizedGreeting = resolveUserPlaceholder(agent.greetingMessage, user?.name);
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

      // Note: materializeAttachments already writes per-file file.upload.attached
      // audit events. No additional attachment audit call is needed here.

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
      // Keep-alive for the resilient dispatch-race retry. Started ONLY when a
      // dispatch-race is actually observed (see onDispatchRaceObserved below) —
      // a known transient apply-lag, NOT a generic hang — so the deliberate
      // "no heartbeats before first chunk" contract (let the client stuck-timer
      // surface real OC hangs) is preserved for the hang case.
      let dispatchRaceKeepAlive: ReturnType<typeof setInterval> | null = null;

      const stream = chatWithDispatchRaceRetry(text, chatOptions as ChatOptions, {
        chat: (m, o) => this.openclawClient.chat(m, o),
        // Deterministic readiness gate: on a dispatch-race, poll OC's RUNTIME
        // `agents.list` (the same `getRuntimeConfig()` view the dispatch handler
        // checks) until this agent is present, instead of blind-sleeping a
        // backoff window. Reading the runtime list — not `config.get` (the FILE,
        // which leads the runtime) — is what makes this reliable. Bounded by the
        // remaining retry budget; never throws, so a probe miss only costs a
        // little latency (the backoff retry remains the backstop). Requires
        // openclaw-node >= 0.12.0; `hasMethod` guards older Gateways.
        awaitAgentReady: (budgetMs) =>
          waitForAgentInRuntime(
            message.agentId,
            {
              hasAgentsListRpc: () => this.openclawClient.hasMethod("agents.list"),
              listRuntimeAgentIds: async () =>
                (await this.openclawClient.agents.list()).agents.map((a) => a.id),
              onWaitObserved: ({ waitedMs, ready, polls }) => {
                if (process.env.PINCHY_E2E_CHAT_TRACE === "1") {
                  console.log(
                    `[trace:chat] readiness-gate agent=${message.agentId} ` +
                      `ready=${ready} waitedMs=${waitedMs} polls=${polls}`
                  );
                }
              },
            },
            { deadlineMs: budgetMs }
          ),
        onDispatchRaceObserved: async ({ providerError }) => {
          // The resilient retry (chat-dispatch-retry.ts) can stay silent for up
          // to ~150 s while OpenClaw applies the agent into its runtime. The
          // browser's stuck-timer (STUCK_TIMEOUT_MS, use-ws-runtime.ts) fires
          // after 60 s of silence and falsely times the run out — so once we
          // KNOW we're in a dispatch-race, re-emit `thinking` every 20 s to keep
          // the UI waiting through the OC restart. The first real chunk also
          // resets that timer, making this redundant-but-harmless once the
          // reply streams. Cleared in the finally below.
          if (!dispatchRaceKeepAlive) {
            dispatchRaceKeepAlive = setInterval(() => {
              this.sendToClient(clientWs, { type: "thinking", messageId });
            }, 20000);
          }
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

      // B-1: register the run at DISPATCH time, before any chunk streams, so a
      // backend that accepts the request but never responds (a wedged or
      // rate-limited lane) is visible to the watchdog. The watchdog tears such
      // a run down after the first-chunk timeout with a RETRYABLE error instead
      // of leaving the user on an indefinitely blank thread. The provisional
      // runId (the per-turn messageId) is reconciled to the real runId by
      // `markFirstChunk` on the first chunk in pipeStream.
      this.activeRuns.registerPending({
        runId: messageId,
        sessionKey,
        agentId: agent.id,
        userId: this.userId,
        agentName: agent.name,
        currentMessageId: messageId,
        submittedAt: Date.now(),
        ws: clientWs,
      });

      try {
        await this.pipeStream(clientWs, stream, agent, sessionKey, messageId);
      } finally {
        if (dispatchRaceKeepAlive) clearInterval(dispatchRaceKeepAlive);
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
    //
    // B-1: only signal a run that has actually STARTED streaming
    // (firstChunkAt !== null). A dispatch-time pending run must NOT flip a
    // reconnecting UI into "responding" — there is nothing to anchor yet, and
    // the watchdog will either reconcile it (first chunk) or tear it down with
    // a retryable error. Either way the frame reaches this ws via the listener
    // set joined above; we just withhold the false "running" signal.
    const activeRunSignal =
      activeRun && activeRun.firstChunkAt !== null
        ? {
            runId: activeRun.runId,
            messageId: activeRun.currentMessageId,
            startedAt: activeRun.startedAt,
            // Tier 2b resume completeness (#470): the text emitted for the
            // in-flight message so far. Snapshotted here in the SAME
            // synchronous block as `addListener` above (no await between) so it
            // can't double-count a chunk that also arrives as a live delta. The
            // client seeds the anchored assistant bubble with this, then
            // appends future deltas.
            partialContent: activeRun.currentContent,
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

    // Authoritative reconnect verdict (chat-liveness-observer Task 2A, Part 2).
    // When there is a STARTED in-flight run for this session, the gateway's
    // `agentWait` oracle is the source of truth for whether the run is still
    // alive, has completed, or has failed — replacing the old client-side
    // silence guess. We capture the runId here (the same gate as
    // `activeRunSignal`: a started run with a real runId) and emit the verdict
    // in the `finally` below so it always follows the history frame the client
    // is about to reconcile against. A pending run has no meaningful runId yet,
    // so it is intentionally excluded.
    const livenessRunId =
      activeRun && activeRun.firstChunkAt !== null ? activeRun.runId : undefined;

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
    } finally {
      // Emit the authoritative reconnect liveness verdict AFTER the history has
      // been sent (whatever branch produced it, including the early `return`s in
      // the catch above). The history is what `completed` refers to ("the reply
      // is/should be in the history just sent"), so the verdict must come last.
      if (livenessRunId !== undefined) {
        await this.emitReconnectLivenessVerdict(clientWs, sessionKey, livenessRunId);
      }
    }
  }

  /**
   * Ask the gateway's authoritative run-liveness oracle (`agentWait`) whether
   * the in-flight run for a reconnecting session is still alive, completed, or
   * failed, and emit a single `liveness` frame with the verdict. This is the
   * core of "only fail when we are sure": Pinchy never guesses failure from
   * silence anymore.
   *
   * Mapping:
   *   - ended (status "ok" with `endedAt`, OR no `livenessState` and ended) and
   *     NOT abandoned → `completed` (the reply is/should be in the history we
   *     just sent).
   *   - still alive (`status` pending/timeout with `livenessState` working /
   *     paused / blocked) → `responding` (keep the UI on "responding"; NEVER
   *     fail a run that is still going).
   *   - `livenessState: "abandoned"`, or `status: "error"` → `failed` with a
   *     reason from `stopReason` (or a generic fallback).
   *
   * Infra hiccups (a thrown `agentWait`) are deliberately NOT turned into a
   * `failed` verdict — we log and skip, letting the existing flow continue.
   */
  private async emitReconnectLivenessVerdict(
    clientWs: WebSocket,
    sessionKey: string,
    runId: string
  ): Promise<void> {
    let result: AgentWaitResult;
    try {
      result = await this.openclawClient.agentWait(runId, {
        timeoutMs: RECONNECT_LIVENESS_TIMEOUT_MS,
      });
    } catch (err) {
      // A gateway hiccup must never manufacture a failure. Log and skip the
      // verdict; the history flow already completed.
      console.warn(
        `[client-router] agentWait failed for run ${runId} on reconnect; skipping liveness verdict:`,
        err instanceof Error ? err.message : err
      );
      return;
    }

    const abandoned = result.livenessState === "abandoned";
    const ended = result.status === "ok" || result.endedAt !== undefined;

    if (result.status === "error" || abandoned) {
      this.broadcastForRun(sessionKey, clientWs, {
        type: "liveness",
        state: "failed",
        reason: result.stopReason ?? "the agent run ended without a response",
      });
      return;
    }

    if (ended) {
      this.broadcastForRun(sessionKey, clientWs, {
        type: "liveness",
        state: "completed",
      });
      return;
    }

    // Still alive (pending/timeout with a non-terminal livenessState, or no
    // terminal signal at all). Keep the UI on "responding" — never fail a run
    // that is still going.
    this.broadcastForRun(sessionKey, clientWs, {
      type: "liveness",
      state: "responding",
    });
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
    // Authoritative liveness: set when a terminal `liveness: failed` verdict has
    // been emitted (a real error chunk OR the silent-stream synthesis). Gates
    // the terminal `liveness: completed` so a failed run is never also reported
    // as completed.
    let emittedFailedLiveness = false;

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
    // Tier 2b resume buffer: the assistant text emitted to clients for the
    // current `messageId` so far. Mirrored into the ActiveRun registry on every
    // emit so a reconnecting client can be re-seeded with the words it streamed
    // before the reload (chunks are deltas; the server never replays them and
    // OpenClaw may not have persisted the partial yet). Reset on each per-turn
    // `done` rotation.
    let emittedContent = "";
    // C-1: set when the first chunk we observe is the synthetic post-abort
    // `done` for a pending run the watchdog already tore down. Lets us skip the
    // silent-stream synthesis + `complete` frame so the user isn't
    // double-signalled for an event the watchdog already handled.
    let tornDownByWatchdog = false;

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
          const firstChunkAt = Date.now();
          // B-1: reconcile the dispatch-time pending registration (created by
          // `registerPending`) to the real runId and flip it to "started". The
          // #470 resume buffer needs no seeding here — it's kept current by the
          // per-emit `setContent` calls below against the same accumulator.
          const reconciled = this.activeRuns.markFirstChunk(sessionKey, firstChunkAt, chunk.runId);
          if (!reconciled) {
            // C-1: the pending run is gone — the watchdog tore it down on the
            // first-chunk timeout and aborted the stream, which is precisely
            // why this synthetic terminal `done` arrived (openclaw-node emits
            // one post-abort). Do NOT resurrect the registry entry and do NOT
            // fall through to the silent-stream net below: the watchdog already
            // notified the user (a retryable error) and audited the event
            // (`chat.run_no_first_chunk`). Bail; the finally still cleans up.
            tornDownByWatchdog = true;
            break;
          }
          activeRunRegistered = true;
          activeRunId = chunk.runId;
          // Authoritative liveness: the run has actually started streaming.
          // Additive to the existing chunk/done frames — the client switchover
          // is a later task. Emitted exactly once per run (gated by
          // `activeRunRegistered` above), before the chunk-specific handling so
          // the "responding" verdict precedes the first text/ack frame.
          this.broadcastForRun(sessionKey, clientWs, {
            type: "liveness",
            state: "responding",
          });
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
              // Accumulate then mirror into the registry in the SAME synchronous
              // block as the broadcast: a reconnect's atomic snapshot+addListener
              // means any chunk is either fully before the snapshot (counted in
              // partialContent, not re-broadcast to the new ws) or fully after
              // (not in the snapshot, delivered as a live delta) — never both.
              emittedContent += emit;
              this.activeRuns.setContent(sessionKey, emittedContent);
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
            // Authoritative liveness: this is a terminal failure. Reuse the
            // provider error text already computed above so the client never has
            // to guess failure from silence. Additive to the `error` frame.
            this.broadcastForRun(sessionKey, clientWs, {
              type: "liveness",
              state: "failed",
              reason: chunk.text,
            });
            emittedFailedLiveness = true;
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
              emittedContent += textBuffer;
              this.activeRuns.setContent(sessionKey, emittedContent);
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
          // The completed turn is now in OpenClaw history; the next turn starts
          // with an empty resume buffer (updateMessageId clears the registry's).
          emittedContent = "";
          messageId = crypto.randomUUID();
          // Tier 2b: keep the registry's view of the current messageId in
          // sync with the per-turn rotation so a reconnecting client gets
          // an `activeRun.messageId` that anchors incoming chunks to the
          // right message after history reconcile.
          if (activeRunRegistered) {
            this.activeRuns.updateMessageId(sessionKey, messageId);
          }
          // #483: low-latency per-turn usage. The just-completed turn is now in
          // OpenClaw history; scan this session's trajectory and record its
          // exact tokens NOW rather than waiting up to a poll interval. Fire-
          // and-forget — recordSessionTurnsUsage never throws, and DB dedup by
          // (sessionKey, runId) makes this and the poll backstop idempotent.
          void recordSessionTurnsUsage({
            openclawClient: this.openclawClient,
            agentId: agent.id,
            userId: this.userId,
            agentName: agent.name,
            sessionKey,
          });
        }
      }

      // C-1: the watchdog already tore this run down (the loop broke on the
      // synthetic post-abort `done`) and already notified the user with a
      // retryable error — skip the silent-stream synthesis and the `complete`
      // frame entirely. The finally still runs to clean up registry/heartbeat.
      if (tornDownByWatchdog) return;

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
        // Authoritative liveness: a silent stream is a terminal failure too, so
        // the client never falls back to a timer guess for this class either.
        this.broadcastForRun(sessionKey, clientWs, {
          type: "liveness",
          state: "failed",
          reason: providerError,
        });
        emittedFailedLiveness = true;

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

      // Authoritative liveness: the run reached its natural terminal end WITHOUT
      // a failure. Gate on `!emittedFailedLiveness` so a stream that already
      // emitted a terminal `liveness: failed` (a real error chunk OR the
      // silent-stream synthesis above) is never contradicted with a `completed`
      // verdict. Emitted BEFORE the `complete` frame so `complete` stays the
      // genuine "no more frames" terminator the client keys its spinner off of.
      // Additive to the `complete` frame; the client switchover to liveness is a
      // later task.
      if (!emittedFailedLiveness) {
        this.broadcastForRun(sessionKey, clientWs, {
          type: "liveness",
          state: "completed",
        });
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
      }
      // B-1/S-1: drop the registry entry for THIS run only. Covers a
      // dispatch-time pending run that errored before its first chunk
      // (`activeRunRegistered` stays false → owned id is the provisional
      // `initialMessageId`) and a normal started run (owned id is the
      // reconciled `activeRunId`). The identity check is critical: a rapid
      // resend replaces the entry with a NEWER run on the same sessionKey, and
      // an unconditional delete here would clobber it — `deleteIfRunId` only
      // removes the entry if it is still ours. Idempotent if the watchdog
      // already tore the run down.
      this.activeRuns.deleteIfRunId(sessionKey, activeRunId ?? initialMessageId);
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

  private async getPersonalizedGreeting(rawGreeting: string): Promise<string> {
    if (!rawGreeting.includes("{user}")) return rawGreeting;
    const user = await db.query.users.findFirst({ where: eq(users.id, this.userId) });
    return resolveUserPlaceholder(rawGreeting, user?.name);
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

/**
 * Vision-capable models from the catalog, used as fallback candidates for an
 * image turn on a text-only agent. Returned in the catalog's natural order; the
 * resolver layers same-provider preference on top.
 */
async function listVisionCandidates(): Promise<VisionCandidate[]> {
  const rows = await db.select().from(models).where(eq(models.vision, true));
  return rows.map((m) => ({
    id: `${m.provider}/${m.modelId}`,
    provider: m.provider,
    tools: m.tools ?? false,
  }));
}

/**
 * The system-wide image model Pinchy already pinned into
 * `agents.defaults.imageModel` (resolveDefaultImageModel, at config-gen time) —
 * used as the cross-provider fallback when the agent's own provider has no
 * vision model. Returns null when the config can't be read; the same-provider
 * candidate path still applies.
 */
function getConfiguredImageModel(): string | null {
  try {
    const cfg = readExistingConfig();
    const agentsCfg = cfg.agents as
      | { defaults?: { imageModel?: { primary?: unknown } } }
      | undefined;
    const primary = agentsCfg?.defaults?.imageModel?.primary;
    return typeof primary === "string" && primary.length > 0 ? primary : null;
  } catch {
    return null;
  }
}
