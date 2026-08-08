import type { OpenClawClient, ChatChunk } from "openclaw-node";
import type { WebSocket } from "ws";
import { iterateUntilAborted } from "@/server/abortable-stream";
import type { DisconnectSignal } from "@/server/openclaw-disconnect-signal";
import { recordSessionTurnsUsage } from "@/lib/usage-per-turn";
import {
  shouldEmitModelUnavailableAudit,
  shouldEmitSilentStreamAudit,
} from "@/server/model-unavailable-throttle";
import type { SessionCache } from "@/server/session-cache";
import type { ActiveRuns } from "@/server/active-runs";
import { getErrorHint, presentProviderError, cannedProviderMessage } from "@/server/error-hints";
import { classifyModelError } from "@/server/model-error-classifier";
import {
  classifyAgentError,
  classifySynthesisedError,
  classifyTransientReason,
  shouldPersistDurableError,
  type AgentErrorClass,
} from "@/server/agent-error-classifier";
import {
  recordChatSessionError,
  supersedeChatSessionErrors,
  agentRanToolSince,
} from "@/server/chat-session-errors";
import {
  SILENT_REPLY_TOKEN,
  safeEmitLength,
  stripFinalEnvelope,
} from "@/server/silent-reply-buffer";
import { db } from "@/db";
import { agentDeliveredFiles } from "@/db/schema";
import { SERVABLE_DELIVERED_MIMES } from "@/lib/serve-workspace-file";
import { and, eq } from "drizzle-orm";
import { appendAuditLog, safeProviderError } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { maybeSelfHealOnModelError } from "@/server/model-self-heal";

// Browsers and intermediate proxies close idle WebSockets after ~30-60s of
// silence. While the agent is in a slow tool-use loop (e.g. local Ollama
// thinking for >60s between turns), the server must keep the socket alive
// with periodic frames. We send a "thinking" heartbeat every 15s — frequent
// enough to defeat any reasonable idle timer, sparse enough not to spam.
const THINKING_HEARTBEAT_MS = 15_000;

// The one generic, non-leaking message shown to the user when a failure can't
// be surfaced with a safe, cause-specific explanation — an internal error whose
// raw text (stack, host/IP, connection string) must not reach the browser.
// Single source of truth so `sanitizeError` (client-router.ts) and this
// thrown-failure sink agree.
export const GENERIC_RUN_FAILURE_MESSAGE = "Something went wrong. Please try again.";

export interface StreamPipeDeps {
  openclawClient: OpenClawClient;
  userId: string;
  userRole: string;
  sessionCache: SessionCache;
  /**
   * Server-wide registry of in-flight chat runs (#310 Tier 2). The SAME
   * instance ClientRouter shares with its other methods (handleAbort,
   * handleHistory) — mutations here must be visible there and vice versa.
   */
  activeRuns: ActiveRuns;
  /**
   * Shared "OpenClaw socket dropped" signal (#7). When OpenClaw disconnects
   * mid-stream, openclaw-node's chat() generator hangs forever, so the drain
   * loop in `pipe` races each chunk against this signal to break out and run
   * its cleanup instead of leaking the heartbeat + ActiveRuns entry.
   */
  disconnectSignal: DisconnectSignal;
  /**
   * Tier 2b broadcast primitive, owned by ClientRouter (it reads the SAME
   * `activeRuns` instance passed above, and its `sendToClient` fallback needs
   * no state of its own). Injected rather than duplicated here so every WS
   * frame in the app — inside and outside the stream pipe — goes through one
   * readyState-gated implementation.
   */
  broadcastForRun: (
    sessionKey: string,
    fallbackWs: WebSocket,
    data: Record<string, unknown>
  ) => void;
}

/**
 * Collaborator extracted from ClientRouter (pinchy#1073, step 1 of the
 * incremental God-Class breakup): the streaming loop used by
 * `ClientRouter.handleMessage`, plus the private helpers it alone drives
 * (artifact delivery, durable error persistence, thrown-failure surfacing,
 * and the `chat.agent_error` umbrella audit). Constructed once per
 * ClientRouter instance with the SAME shared state (activeRuns,
 * disconnectSignal, sessionCache, userId, userRole, openclawClient) the
 * router itself holds — no new sharing semantics, just an explicit seam.
 */
export class StreamPipe {
  constructor(private readonly deps: StreamPipeDeps) {}

  // Shared streaming loop used by handleMessage. Handles heartbeat, chunk
  // routing (text/error/done/userMessagePersisted), and the terminal "complete"
  // frame. The loop drains the OpenClaw stream to its natural end regardless
  // of browser WS state — Pinchy-side accounting (sessionCache, messageId
  // rotation) always runs; consumer-bound frames are gated by readyState so
  // we don't write to a closed socket. This makes the assistant reply
  // deterministically present in OpenClaw's session.jsonl by the time the
  // user reconnects (issue #199 Layer B).
  async pipe(
    clientWs: WebSocket,
    stream: AsyncIterable<ChatChunk>,
    agent: { id: string; name: string; model?: string | null },
    sessionKey: string,
    initialMessageId: string
  ): Promise<void> {
    const { openclawClient, userId, userRole, sessionCache, activeRuns, disconnectSignal } =
      this.deps;
    const broadcastForRun = this.deps.broadcastForRun;

    let messageId = initialMessageId;
    // The id the most recent turn actually streamed into. `messageId` rotates to
    // a fresh id on each `done` (for the NEXT turn), so after the loop it no
    // longer names any bubble the client rendered. The post-run delivery poll
    // (#703) needs the streamed id to bind chips to the reply — capture it here,
    // just before each rotation.
    let lastStreamedMessageId = initialMessageId;

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
    // Durable chat-error banner (Concern 1): the triggering user message id
    // anchors supersede + a safe retry. `runStartedAt` (with a small clock-skew
    // buffer) bounds the audit lookup that decides `sideEffects` — whether the
    // run executed a tool, so the banner can warn that a retry may duplicate
    // already-applied writes.
    let triggeringClientMessageId: string | undefined;
    const runStartedAt = new Date(Date.now() - 2000);
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
    // #7: set when OpenClaw drops the socket mid-stream. The chat() generator
    // then hangs forever, so we race each chunk against the disconnect signal
    // and break out. There is no real terminal verdict to compute in that case
    // (the run did NOT complete), so this gates the silent-stream synthesis,
    // the `complete`/`liveness` frames, and the `run_completed_after_disconnect`
    // audit below — only the finally cleanup (heartbeat + registry) still runs.
    let openclawDisconnected = false;

    try {
      for await (const chunk of iterateUntilAborted(
        stream,
        disconnectSignal.whenDisconnected(),
        () => {
          openclawDisconnected = true;
        }
      )) {
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
            broadcastForRun(sessionKey, clientWs, { type: "thinking", messageId });
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
          const reconciled = activeRuns.markFirstChunk(sessionKey, firstChunkAt, chunk.runId);
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
          broadcastForRun(sessionKey, clientWs, {
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
          activeRuns.touch(sessionKey, Date.now());
        }
        if (chunk.type === "error") {
          sawTerminalError = true;
        }
        // Durable-banner bookkeeping: `userMessagePersisted` is OC's first chunk
        // and carries the triggering client message id (anchor for supersede +
        // retry). Tool execution is NOT signalled as a chunk by OpenClaw — the
        // sideEffects flag is derived from the audit trail at persist time.
        if (chunk.type === "userMessagePersisted") {
          triggeringClientMessageId = chunk.clientMessageId;
        }

        // Pinchy-side accounting — runs regardless of consumer state. The
        // browser may have navigated away, but OpenClaw is still streaming
        // and persisting on its side; our local view of the session
        // (sessionCache, per-turn messageId rotation) must keep up so the
        // next history fetch / WS reconnect sees a coherent state.
        // Note: errored turns intentionally do NOT update the cache — only
        // turns that reach a `done` chunk count as completed sessions.
        if (chunk.type === "done") {
          sessionCache.add(sessionKey);
          // A SUCCESSFUL turn's `done` supersedes the message's durable error.
          // OpenClaw also emits a terminal `done` AFTER an `error` chunk to close
          // the stream — superseding on that would immediately clear the error we
          // just persisted, so the banner would never appear. `sawTerminalError`
          // (set on any error chunk earlier in this stream) gates it out. Scoped
          // to the triggering id so an unrelated later message succeeding never
          // clears an unanswered error. Best-effort.
          if (!sawTerminalError) {
            try {
              await supersedeChatSessionErrors({
                sessionKey,
                clientMessageId: triggeringClientMessageId,
              });
            } catch (err) {
              console.error("Failed to supersede durable chat error:", err);
            }
          }
        }

        // Server-side error logging — unconditional. With the drain-always
        // loop, error chunks arriving after the browser navigates away are
        // exactly the chunks operators most need to see (no UI to surface
        // them). Gating this on readyState would silently swallow upstream
        // failures during nav-aways.
        //
        // sideEffects is computed once by the durable-persist below (audit-
        // derived) and reused for the live error frame further down, so a
        // failed run's in-chat retry and its durable banner agree without a
        // second DB query — and inherit the persist's best-effort try/catch
        // (a persist failure can never break the live error frame).
        let liveSideEffects = false;
        if (chunk.type === "error") {
          console.error("OpenClaw error chunk:", chunk.text);

          // Issue #355: universal `chat.agent_error` audit. Fires for every
          // error chunk regardless of clientWs state and regardless of
          // whether a more specialised event (agent.model_unavailable,
          // chat.silent_stream further below) also fires. The specialised
          // events stay in their role as
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
          const errorClass = classifyAgentError(chunk.text);
          await this.writeAgentErrorAudit({
            agent,
            errorClass,
            providerError: chunk.text,
          });
          // Durable banner (Concern 1): mirror the error into chat_session_errors
          // so it survives reload/reconnect. Best-effort — never fails the stream.
          // Returns the audit-derived sideEffects flag, reused for the live frame.
          liveSideEffects = await this.persistDurableChatError({
            agent,
            sessionKey,
            clientMessageId: triggeringClientMessageId,
            runId: activeRunId,
            providerError: chunk.text,
            errorClass,
            runStartedAt,
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
            broadcastForRun(sessionKey, clientWs, {
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
              activeRuns.setContent(sessionKey, emittedContent);
              broadcastForRun(sessionKey, clientWs, {
                type: "chunk",
                content: emit,
                messageId,
              });
            }
          } else if (chunk.type === "error") {
            sawError = true;
            const modelUnavailable = classifyModelError(chunk.text, agent.model ?? "");
            // Carry sideEffects on the LIVE frame too (reusing the audit-derived
            // value the durable-persist above already computed) so the in-chat
            // bubble's retry is gated behind the duplicate-write confirm — not
            // just the durable banner after reload.
            broadcastForRun(sessionKey, clientWs, {
              type: "error",
              agentName: agent.name,
              // Banner display only — rewrites OpenClaw's context-overflow /reset
              // advice (#611) and names the dispatched model for a retired/
              // unclassified error (#611 follow-up). The audit + durable-persist
              // keep the raw text.
              providerError: presentProviderError(chunk.text, agent.model ?? undefined),
              hint: getErrorHint(chunk.text, userRole),
              messageId,
              ...(modelUnavailable ? { modelUnavailable } : {}),
              ...(liveSideEffects ? { sideEffects: true } : {}),
            });
            // Authoritative liveness: this is a terminal failure. Reuse the
            // provider error text already computed above so the client never has
            // to guess failure from silence. Additive to the `error` frame.
            broadcastForRun(sessionKey, clientWs, {
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
                actorId: userId,
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
          } else if (chunk.type === "done") {
            // Flush remaining buffer at end-of-turn. If the entire turn
            // resolved to the silent-reply sentinel, suppress it; otherwise
            // emit whatever text was held back.
            if (textBuffer && textBuffer !== SILENT_REPLY_TOKEN) {
              emittedContent += textBuffer;
              activeRuns.setContent(sessionKey, emittedContent);
              broadcastForRun(sessionKey, clientWs, {
                type: "chunk",
                content: textBuffer,
                messageId,
              });
            }
            broadcastForRun(sessionKey, clientWs, { type: "done", messageId });
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
          // Remember the id this turn streamed into before rotating away from it,
          // so the post-run delivery poll can bind chips to this reply (#703).
          lastStreamedMessageId = messageId;
          messageId = crypto.randomUUID();
          // Tier 2b: keep the registry's view of the current messageId in
          // sync with the per-turn rotation so a reconnecting client gets
          // an `activeRun.messageId` that anchors incoming chunks to the
          // right message after history reconcile.
          if (activeRunRegistered) {
            activeRuns.updateMessageId(sessionKey, messageId);
          }
          // #483: low-latency per-turn usage. The just-completed turn is now in
          // OpenClaw history; scan this session's trajectory and record its
          // exact tokens NOW rather than waiting up to a poll interval. Fire-
          // and-forget — recordSessionTurnsUsage never throws, and DB dedup by
          // (sessionKey, runId) makes this and the poll backstop idempotent.
          void recordSessionTurnsUsage({
            openclawClient,
            agentId: agent.id,
            userId,
            agentName: agent.name,
            sessionKey,
          });
        }
      }

      // Agent → user file delivery (#703): the OpenClaw gateway does not stream
      // native plugin tool-output text to openclaw-node, so a delivery cannot be
      // observed inline. Instead, once the run's stream has closed, ask OpenClaw
      // for the artifacts its transcript accumulated (`artifacts.list`) and turn
      // any file/image blocks into per-user download grants + chips. Wrapped so a
      // failed poll never breaks the run.
      try {
        await this.deliverRunArtifacts(sessionKey, agent, clientWs, lastStreamedMessageId);
      } catch (err) {
        console.error("[delivery] artifacts poll failed", err);
      }

      // #7: OpenClaw dropped the socket mid-stream. The stream will never
      // produce a terminal chunk, so there is nothing to synthesize and no
      // genuine `complete`. Skip straight to the finally cleanup so the
      // heartbeat interval and ActiveRuns entry don't leak. The browser WS is
      // being closed by the disconnect handler, which fires the client's own
      // reconnect/error recovery.
      if (openclawDisconnected) return;

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
        // Durable banner: a silent timeout is also a "no response" the user
        // should still see after a reload. Best-effort. Computed before the
        // frame so the live retry is gated on the same audit-derived
        // sideEffects signal as the error-chunk path above.
        const sideEffects = await this.persistDurableChatError({
          agent,
          sessionKey,
          clientMessageId: triggeringClientMessageId,
          runId: activeRunId,
          providerError,
          errorClass: classifySynthesisedError("silent_stream"),
          runStartedAt,
        });
        // Tier 2b: broadcast so a tab joined via reconnect-resume also
        // sees the synthesised error (the original ws might already be
        // gone). The listener-set fallback inside broadcastForRun reaches
        // the originating ws when no run is registered, e.g. if the OC
        // stream produced zero chunks at all.
        broadcastForRun(sessionKey, clientWs, {
          type: "error",
          agentName: agent.name,
          providerError,
          hint: getErrorHint(providerError, userRole),
          messageId,
          ...(sideEffects ? { sideEffects: true } : {}),
        });
        // Authoritative liveness: a silent stream is a terminal failure too, so
        // the client never falls back to a timer guess for this class either.
        broadcastForRun(sessionKey, clientWs, {
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
            actorId: userId,
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
        broadcastForRun(sessionKey, clientWs, {
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
      broadcastForRun(sessionKey, clientWs, { type: "complete" });
    } catch (err) {
      // A THROWN terminal failure: the chat() generator rejected mid-stream
      // (an RPC-level FailoverError / provider error OpenClaw raises instead of
      // yielding an `error` chunk). Route it through the SAME rich sink as an
      // in-stream error chunk so it's classified, audited, persisted (class-
      // gated) and shown with the provider message + model name + hint — never
      // the old generic "Something went wrong" bubble from the send-handler
      // catch (#882).
      //
      // `openclawDisconnected` is the one case that is NOT a run failure: the
      // socket dropped and `iterateUntilAborted` surfaced it. That is handled by
      // the disconnect machinery + the client's own reconnect; re-surfacing it as
      // an agent error would double-signal. The finally below still cleans up.
      if (!openclawDisconnected) {
        sawTerminalError = true;
        await this.surfaceRunFailure({
          clientWs,
          agent,
          sessionKey,
          messageId,
          providerError: err instanceof Error ? err.message : String(err),
          clientMessageId: triggeringClientMessageId,
          runId: activeRunId,
          runStartedAt,
        });
        // No `complete` frame on a thrown failure: the `error` frame already
        // stops the client's thinking indicator, and `complete` is reserved for
        // a stream that reached its natural end (existing contract asserted by
        // "should not send a 'complete' message when the stream errors").
      }
    } finally {
      // #310 Tier 2a: clean up the registry entry and, if the run finished
      // normally but with zero listeners, write a chat.run_completed_after_disconnect
      // audit row so operators can see "this run completed for a browser
      // session that had already gone away". A terminated error path
      // (sawTerminalError === true) doesn't get this audit — that's
      // covered by the existing chat.agent_error / classified events.
      if (activeRunRegistered) {
        const run = activeRuns.get(sessionKey);
        // `!openclawDisconnected`: a run abandoned because OpenClaw dropped the
        // socket did NOT complete, so it must not be logged as
        // `run_completed_after_disconnect` (that event means the browser left
        // but the reply still finished server-side).
        if (run && run.listeners.size === 0 && !sawTerminalError && !openclawDisconnected) {
          const auditEntry = {
            actorType: "user" as const,
            actorId: userId,
            eventType: "chat.run_completed_after_disconnect" as const,
            resource: `agent:${agent.id}`,
            detail: {
              agent: { id: agent.id, name: agent.name },
              user: { id: userId },
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
      activeRuns.deleteIfRunId(sessionKey, activeRunId ?? initialMessageId);
      if (heartbeatInterval !== null) {
        clearInterval(heartbeatInterval);
      }
    }
  }

  /**
   * Agent → user file delivery (#703). Called once the run's stream has closed.
   * The OpenClaw gateway does not stream native plugin tool-output text to
   * openclaw-node, so a delivery marker in tool output never reaches us. Instead
   * we ask OpenClaw's native `artifacts.list` RPC for the file/image content
   * blocks its session transcript accumulated, and for each new one we:
   *
   *   1. Record a per-user download grant (the authorization the serving route
   *      checks — without it the file 404s, so a grant-insert failure skips the
   *      chip rather than showing an undownloadable file).
   *   2. Audit `file.delivered` (WS scope → appendAuditLog + recordAuditFailure).
   *   3. Broadcast a `file` frame the client attaches to the current assistant
   *      message.
   *
   * `artifacts.list` is cumulative across the whole session, so this runs after
   * every turn and must be idempotent: a grant already recorded for this user +
   * agent + filename is skipped (no duplicate insert, audit, or chip). Because
   * the list is cumulative we fetch the caller's already-granted filenames ONCE
   * per poll (not once per artifact) and diff in memory.
   *
   * Only files the serving route can actually stream are delivered — a type
   * outside SERVABLE_DELIVERED_MIMES would 415 on download, so we never mint a
   * grant/chip/success-audit for it (the chip would just fail to open).
   *
   * `userId` comes from `this.deps.userId` (server-side), never from the
   * artifact — a plugin cannot deliver a file to anyone but the chat's own
   * user.
   *
   * `messageId` is the id the run streamed its reply into (captured before the
   * per-turn rotation), so the client binds the chip to that reply bubble rather
   * than spawning a stray one.
   */
  private async deliverRunArtifacts(
    sessionKey: string,
    agent: { id: string; name: string },
    clientWs: WebSocket,
    messageId: string
  ): Promise<void> {
    const { openclawClient, userId, broadcastForRun } = this.deps;
    const res = await openclawClient.request("artifacts.list", { sessionKey });
    const artifacts =
      (res.payload as { artifacts?: Array<{ type?: string; title?: string; mimeType?: string }> })
        ?.artifacts ?? [];

    // Only file/image artifacts with a name are deliverable. Resolve the set
    // BEFORE touching the DB so an ordinary turn (no artifacts — the common case)
    // never runs a grant query.
    const candidates = artifacts.filter(
      (a): a is { type: string; title: string; mimeType?: string } =>
        (a.type === "file" || a.type === "image") && !!a.title
    );
    if (candidates.length === 0) return;

    // One batched lookup of this (agent, user)'s already-granted filenames — the
    // idempotency set for a cumulative artifacts.list. `delivered` also absorbs
    // titles minted within THIS poll so a duplicate title can't double-insert.
    const priorGrants = await db
      .select({ filename: agentDeliveredFiles.filename })
      .from(agentDeliveredFiles)
      .where(
        and(eq(agentDeliveredFiles.agentId, agent.id), eq(agentDeliveredFiles.userId, userId))
      );
    const delivered = new Set(priorGrants.map((g) => g.filename));

    for (const a of candidates) {
      const filename = a.title;
      if (delivered.has(filename)) continue;
      const mimeType = a.mimeType ?? "application/octet-stream";

      // Only deliver what the serving route can stream. A non-servable type
      // (docx/zip, or an unknown that defaulted to octet-stream) would 415
      // on download — surfacing a chip that fails to open, with a success audit.
      // xlsx IS servable (#788) — see SERVABLE_DELIVERED_MIMES.
      if (!SERVABLE_DELIVERED_MIMES.has(mimeType)) continue;

      try {
        await db.insert(agentDeliveredFiles).values({
          userId,
          agentId: agent.id,
          sessionKey,
          filename,
          mimeType,
        });
      } catch (err) {
        // The grant is the authorization; without it the serving route 404s.
        // Skip the chip so we never surface an undownloadable file.
        console.error("[delivery] failed to record delivery grant", err);
        continue;
      }
      delivered.add(filename);

      const auditEntry = {
        actorType: "user" as const,
        actorId: userId,
        eventType: "file.delivered" as const,
        resource: `agent:${agent.id}`,
        detail: {
          agent: { id: agent.id, name: agent.name },
          filename,
          mimeType,
        },
        outcome: "success" as const,
      };
      try {
        await appendAuditLog(auditEntry);
      } catch (err) {
        recordAuditFailure(err, auditEntry);
      }

      broadcastForRun(sessionKey, clientWs, {
        type: "file",
        messageId,
        filename,
        mimeType,
      });
    }
  }

  /**
   * Write the `chat.agent_error` umbrella audit row (issue #355).
   *
   * Universal measurement signal: fires for every error chunk that reaches
   * the chat WS error surface, plus the silent-stream synthesised error.
   * Specialised events (agent.model_unavailable, chat.silent_stream)
   * remain in their role as throttled operational
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
  /**
   * Mirror an agent error into the durable `chat_session_errors` store that
   * backs the chat "paused" banner (Concern 1). Best-effort: a failure here is
   * logged but never propagated, so it can't break the stream or lose the audit
   * row that already landed. `transientReason` is only meaningful for the
   * `transient` class, where it lets the banner name the actual cause.
   */
  private async persistDurableChatError(args: {
    agent: { id: string; name: string; model?: string | null };
    sessionKey: string;
    clientMessageId?: string;
    runId?: string;
    providerError: string;
    errorClass: AgentErrorClass;
    runStartedAt: Date;
    /**
     * Force the row off the banner regardless of class. The #882 generic path
     * needs it: the class can say "banner-worthy" while the text is not safe to
     * re-render, and the row is written there only to carry the retry-gate
     * window.
     */
    suppressBanner?: boolean;
  }): Promise<boolean> {
    const { userId } = this.deps;
    try {
      // Derive sideEffects from the audit trail: OpenClaw doesn't signal tool
      // execution as a chat chunk, so a `tool.*` audit row since this run began
      // is the reliable "the agent already acted" signal.
      //
      // This answer is provisional. OpenClaw fires `after_tool_call` WITHOUT
      // awaiting it, so `pinchy-audit`'s row is ordered against nothing and can
      // still be in flight right now — `false` here does not mean the run was
      // read-only (#1013). `runStartedAt` goes into the row so `resolveRetryGate`
      // can ask the same question again when the user reaches for Retry.
      const sideEffects = await agentRanToolSince(args.agent.id, args.runStartedAt);
      // EVERY failed run is recorded, because every failed run can be retried
      // and every retry needs the gate. Whether it also re-surfaces as a
      // "paused" banner is a separate question: a persistent problem with
      // nothing actionable to say (`unknown`) is inline-only, and so is a
      // failure whose text we must not re-render. See shouldPersistDurableError.
      await recordChatSessionError({
        userId,
        agentId: args.agent.id,
        sessionKey: args.sessionKey,
        clientMessageId: args.clientMessageId ?? null,
        runId: args.runId ?? null,
        agentName: args.agent.name,
        model: args.agent.model ?? null,
        errorClass: args.errorClass,
        transientReason:
          args.errorClass === "transient" ? classifyTransientReason(args.providerError) : null,
        providerError: safeProviderError(args.providerError),
        sideEffects,
        runStartedAt: args.runStartedAt,
        showBanner: !args.suppressBanner && shouldPersistDurableError(args.errorClass),
      });
      return sideEffects;
    } catch (err) {
      console.error("Failed to persist durable chat error:", err);
      // Best-effort: a persist failure must never break the live error frame.
      // Default to "no side effects" so the in-chat retry stays ungated rather
      // than spuriously demanding a duplicate-write confirm.
      return false;
    }
  }

  /**
   * Terminal-failure sink for a run-level error that arrives as a THROWN
   * exception (the `chat()` generator rejecting, an RPC-level provider error
   * OpenClaw raises instead of yielding an in-stream `error` chunk) rather than
   * as a `type: "error"` chunk. Mirrors the in-stream error-chunk branch in
   * `pipe`: classify → umbrella audit → durable persist (class-gated) → rich
   * `type: "error"` frame + terminal `liveness: "failed"`.
   *
   * Without this, a thrown provider failure fell through to the send-handler
   * catch and `sanitizeError` collapsed it to the opaque "Something went wrong."
   * bubble — no class, no audit, no durable row, no model name. That is issue
   * #882's core "no response / not diagnosable" symptom.
   *
   * Every decision here goes through the SAME sub-helpers the chunk path uses
   * (`classifyAgentError`, `classifyModelError`, `writeAgentErrorAudit`,
   * `persistDurableChatError`, `presentProviderError`, `getErrorHint`), so
   * classification, audit content, presentation and persistence rules can't
   * drift between the two paths.
   */
  private async surfaceRunFailure(args: {
    clientWs: WebSocket;
    agent: { id: string; name: string; model?: string | null };
    sessionKey: string;
    messageId: string;
    providerError: string;
    clientMessageId?: string;
    runId?: string;
    runStartedAt: Date;
  }): Promise<void> {
    const { userRole, broadcastForRun } = this.deps;
    const errorClass = classifyAgentError(args.providerError);
    // Server-side, unconditional: log + umbrella audit for EVERY thrown run
    // failure, even the ones we won't show the user below. This is the
    // diagnosability trail #882 asks for — an operator can now see the failure
    // in `chat.agent_error` (PII-scrubbed) instead of it vanishing. Audit BEFORE
    // any browser-facing forwarding (matching the chunk path) so a forwarding
    // throw can't lose the trail; also runs the model-retirement self-heal hook.
    console.error("Agent run failure (thrown):", args.providerError);
    await this.writeAgentErrorAudit({
      agent: args.agent,
      errorClass,
      providerError: args.providerError,
    });

    // Security gate for the THROWN path: `err.message` is NOT guaranteed to be
    // provider-facing. A generator rejection can be an internal Node/infra error
    // — a connection `ETIMEDOUT` carrying a host/IP, a Postgres auth failure, a
    // stack trace — and `classifyAgentError` will happily label some of those
    // `transient` ("timed out") or `provider_config` ("authenticat"), so a class
    // check ALONE (e.g. `errorClass === "unknown"`) is not a safe filter. The
    // real question is whether we can show a SAFE, cause-specific message without
    // echoing the raw text: `cannedProviderMessage` returns one only for errors
    // that `presentProviderError` fully REWRITES (retired model → names the
    // model; context overflow; the #584 account-rejection envelope), and `null`
    // for everything it would otherwise echo verbatim. On `null` we fall back to
    // the generic, non-leaking bubble — and crucially DON'T persist, because the
    // durable banner re-renders the stored raw text through `presentProviderError`
    // on reload (a second leak vector). The in-stream `error` chunk path needs
    // none of this: `chunk.text` is provider-facing by construction. (#882)
    const safeMessage = cannedProviderMessage(args.providerError, args.agent.model ?? undefined);
    if (safeMessage === null) {
      // The generic bubble is still RETRYABLE, and this run may already have
      // written to Odoo before it died. Record the run window — with the canned
      // text, never `err.message` — so `resolveRetryGate` can answer for this
      // retry too. `suppressBanner` keeps the row where it was: off screen.
      await this.persistDurableChatError({
        agent: args.agent,
        sessionKey: args.sessionKey,
        clientMessageId: args.clientMessageId,
        runId: args.runId,
        providerError: GENERIC_RUN_FAILURE_MESSAGE,
        errorClass,
        runStartedAt: args.runStartedAt,
        suppressBanner: true,
      });
      broadcastForRun(args.sessionKey, args.clientWs, {
        type: "error",
        message: GENERIC_RUN_FAILURE_MESSAGE,
        messageId: args.messageId,
      });
      return;
    }

    // Durable banner (class-gated) + the audit-derived sideEffects flag reused by
    // the live frame's retry gate. Best-effort; never throws. Safe to persist the
    // raw text here: only a class with a canned rewrite reaches this point, so the
    // reload path's `presentProviderError` rewrites it too and never echoes it.
    const sideEffects = await this.persistDurableChatError({
      agent: args.agent,
      sessionKey: args.sessionKey,
      clientMessageId: args.clientMessageId,
      runId: args.runId,
      providerError: args.providerError,
      errorClass,
      runStartedAt: args.runStartedAt,
    });
    const modelUnavailable = classifyModelError(args.providerError, args.agent.model ?? "");
    broadcastForRun(args.sessionKey, args.clientWs, {
      type: "error",
      agentName: args.agent.name,
      // The canned rewrite, never the raw `err.message` — see the security gate
      // above. `getErrorHint` only ever returns canned strings or null, so it's
      // safe to derive off the raw text.
      providerError: safeMessage,
      hint: getErrorHint(args.providerError, userRole),
      messageId: args.messageId,
      ...(modelUnavailable ? { modelUnavailable } : {}),
      ...(sideEffects ? { sideEffects: true } : {}),
    });
    // Authoritative liveness: a recognised thrown failure is terminal, so the
    // client never falls back to a stuck-timer guess for it. Uses the SAFE
    // presented text, never the raw `err.message`, so `reason` can't leak
    // internal error text either.
    broadcastForRun(args.sessionKey, args.clientWs, {
      type: "liveness",
      state: "failed",
      reason: safeMessage,
    });
  }

  /**
   * Called from `pipe`/`surfaceRunFailure` above, and from ClientRouter's
   * dispatch-race retry hook in `handleMessage` (the one caller outside this
   * class) — see `chat-dispatch-retry.ts`.
   */
  async writeAgentErrorAudit(args: {
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
    const { userId } = this.deps;
    const auditEntry = {
      actorType: "user" as const,
      actorId: userId,
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

    // Self-heal: if this error means the agent's model was retired upstream
    // (HTTP 410 / "Unknown model"), regenerate config so it re-resolves to a
    // live model. Fire-and-forget + debounced + never throws.
    //
    // Scope: this hook covers the CHAT-model path (an agent pinned to a model
    // that was retired). The built-in pdf/image tools hit the same failure on
    // their own dispatch path, but Pinchy is removing those in favour of
    // pinchy_read (#501 follow-up), so we don't wire self-heal into the
    // tool-dispatch audit path here.
    void maybeSelfHealOnModelError(args.providerError);
  }
}
