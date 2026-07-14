import type { ChatOptions, OpenClawClient } from "openclaw-node";

import { RunDeferredError } from "@/lib/email-workflows/dispatch";
import type { RunAgent, WorkflowForDispatch } from "@/lib/email-workflows/dispatch";
import { parseInboxReport } from "@/lib/email-workflows/report";
import type { DispatchableEmail } from "@/lib/email-workflows/types";
import { inboxSessionKey } from "@/lib/session-key";
import { stripFinalEnvelope } from "@/server/silent-reply-buffer";

/**
 * The production RunAgent (#139): one isolated OpenClaw run per claimed email.
 *
 * Native capabilities only, on the current OpenClaw pin — no version bump:
 * - Isolation via the session model: each run lives at
 *   `agent:<id>:inbox:<ledgerId>` (see {@link inboxSessionKey}), so it never
 *   surfaces as a user chat and the daily session reset garbage-collects it.
 * - The task rides in as a normal chat turn; the agent reads the full email
 *   itself through its email tools, so its own permissions govern the run.
 * - The result comes back as the final assistant text ending in one fenced
 *   JSON block ({@link parseInboxReport}). NOT a tool call: real Gateways do
 *   not emit `tool_use` chunks through `chat()`, so a report tool would be
 *   invisible here — the final text is the native result channel.
 *
 * Failure semantics match the dispatcher's contract: any throw is a *run*
 * failure (finalize `failed` + failure notification), never a stuck ledger row.
 * A hung run is aborted via `chatAbort` after `timeoutMs` so a wedged provider
 * can't stall the whole batch. One verified Gateway gotcha is load-bearing:
 * `done` is also emitted AFTER `error`, so success is keyed on "no error chunk
 * seen", never on `done`.
 */
export interface OpenClawRunAgentDeps {
  /** The gateway client; only the chat/abort seam is used. */
  client: Pick<OpenClawClient, "chat" | "chatAbort">;
  /**
   * The agent's `provider/model` ref from Pinchy's DB. Passed explicitly to
   * the Gateway because its `agent` RPC otherwise resolves capability checks
   * against the gateway-wide default model (#324).
   */
  loadAgentModel: (agentId: string) => Promise<string | null>;
  /**
   * Runtime-readiness gate (`waitForAgentInRuntime`): a config reload can lag
   * behind the DB, and dispatching into that window fails with "unknown agent
   * id" — which would terminally fail the email instead of retrying.
   */
  waitForAgentReady: (agentId: string) => Promise<boolean>;
  /** Watchdog for a single turn; default 5 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const REPORT_CONTRACT = `You are executing an automated inbox workflow run. No human reads this conversation or can answer questions — decide and act using your tools.
End your reply with exactly one fenced \`\`\`json code block of this shape:
{"status": "done" | "no_action", "title": "<short headline for the activity feed>", "content": "<what you did or found>", "outcome": {"odooModel": "<model>", "odooId": <record id>, "link": "<url>", "note": "<text>"}}
Use "status": "no_action" when the email needs nothing done. "outcome" is optional — include it when you created or changed a record. The JSON block must be the last thing in your reply.`;

export function createOpenClawRunAgent(deps: OpenClawRunAgentDeps): RunAgent {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async ({ workflow, email, ledgerId }) => {
    const model = await deps.loadAgentModel(workflow.agentId);
    if (!model) {
      throw new Error(`agent ${workflow.agentId} has no model configured`);
    }
    if (!(await deps.waitForAgentReady(workflow.agentId))) {
      // Transient: the agent hasn't landed in the runtime yet (a config reload
      // lagging a restart). Defer, don't fail — the sweep retries `processing`.
      throw new RunDeferredError(`agent ${workflow.agentId} is not in the OpenClaw runtime yet`);
    }

    const sessionKey = inboxSessionKey(workflow.agentId, ledgerId);
    const options: ChatOptions = {
      sessionKey,
      agentId: workflow.agentId,
      extraSystemPrompt: REPORT_CONTRACT,
    };
    // Split on the FIRST '/' only: provider before, model after — model ids can
    // themselves contain '/' (same convention as the WS router, #324).
    const slashIdx = model.indexOf("/");
    if (slashIdx > 0 && slashIdx < model.length - 1) {
      options.provider = model.slice(0, slashIdx);
      options.model = model.slice(slashIdx + 1);
    }

    const first = await collectTurn(deps.client, taskMessage(workflow, email), options, {
      sessionKey,
      timeoutMs,
    });
    let runId = first.runId;
    let parsed = parseInboxReport(first.text);

    if (!parsed.ok) {
      // One correction turn in the SAME session — the model keeps its context
      // and only has to restate the result in the required shape.
      const second = await collectTurn(deps.client, correctionMessage(parsed.error), options, {
        sessionKey,
        timeoutMs,
      });
      runId = second.runId ?? runId;
      parsed = parseInboxReport(second.text);
      if (!parsed.ok) {
        throw new Error(`run did not produce a valid report: ${parsed.error}`);
      }
    }

    return {
      status: parsed.report.status,
      title: parsed.report.title,
      content: parsed.report.content,
      outcome: parsed.report.outcome,
      runId,
    };
  };
}

function taskMessage(workflow: WorkflowForDispatch, email: DispatchableEmail): string {
  const attachments =
    email.attachments.length === 0
      ? "none"
      : email.attachments
          .map((a) => (a.filename ? `${a.filename} (${a.contentType})` : a.contentType))
          .join(", ");
  return `Automated inbox workflow "${workflow.name}".

Task: ${workflow.action}

Email to process — read the full message with your email tools using the provider message id:
- Provider message id: ${email.providerMessageId}
- From: ${email.from}
- Subject: ${email.subject}
- Received: ${email.receivedAt.toISOString()}
- Folder: ${email.folder ?? "unknown"}
- Attachments: ${attachments}`;
}

function correctionMessage(parseError: string): string {
  return `Your last reply did not contain a valid report. ${parseError}
Reply with ONLY the fenced \`\`\`json report block — no other text.`;
}

/** Sentinel so the watchdog is distinguishable from stream errors. */
class TurnTimeout extends Error {}

/**
 * Drain one chat turn: accumulate text, capture the runId, remember a terminal
 * error chunk. The stream is consumed to completion (`done` also follows
 * `error`), then the error — if any — is thrown.
 */
async function collectTurn(
  client: Pick<OpenClawClient, "chat" | "chatAbort">,
  message: string,
  options: ChatOptions,
  run: { sessionKey: string; timeoutMs: number }
): Promise<{ text: string; runId?: string }> {
  const generator = client.chat(message, options);
  let buffer = "";
  let runId: string | undefined;
  let errorText: string | null = null;

  const consume = async () => {
    for await (const chunk of generator) {
      runId ??= chunk.runId;
      if (chunk.type === "text") {
        buffer += chunk.text;
      } else if (chunk.type === "error") {
        errorText = chunk.text || "OpenClaw run failed";
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnTimeout()), run.timeoutMs);
  });

  try {
    await Promise.race([consume(), watchdog]);
  } catch (err) {
    if (err instanceof TurnTimeout) {
      // Kill the zombie run server-side; the local generator is abandoned.
      try {
        await client.chatAbort(run.sessionKey, runId);
      } catch {
        // Best-effort: the run may already be gone.
      }
      throw new Error(`inbox run timed out after ${run.timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (errorText !== null) {
    throw new Error(errorText);
  }
  return { text: stripFinalEnvelope(buffer), runId };
}
