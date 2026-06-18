// audit-exempt: session compaction is non-destructive housekeeping — OpenClaw
// summarizes the in-context transcript while the full session JSONL is retained
// on disk. No data is deleted, no permission or security state changes, so the
// governance value of an audit row is low. (User-triggered, so a SOC2 "who
// compacted when" attribution gap is accepted; trivially upgradable to a
// chat.session_compacted event later if needed.) Sanctioned in the Agent
// Memory System design review.
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { parseRequestBody } from "@/lib/api-validation";
import { getOpenClawClient } from "@/server/openclaw-client";
import { compactSessionSchema } from "@/lib/schemas/sessions";
import { allowCompaction } from "@/lib/compact-throttle";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * Manually compact the caller's chat session with this agent. Lets a user
 * shrink a long-running conversation's context (which degrades model quality
 * as it grows) without losing the on-disk transcript. Compaction takes effect
 * on the next turn; we deliberately do NOT force a history reload so the user's
 * visible messages don't vanish from under them.
 */
export const POST = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const parsed = await parseRequestBody(compactSessionSchema, request);
  if ("error" in parsed) return parsed.error;

  // Per-user, per-chat session scoping, identical to
  // ClientRouter.computeSessionKey: agent:<agentId>:direct:<userId>[:<chatId>].
  // The optional chatId (#508) targets the chat the user is actually looking at
  // on /chat/<agentId>/<chatId>; omitting it compacts the default per-user
  // session. OpenClaw validates that the agentId in the key matches the agentId
  // argument — see MEMORY.md "OpenClaw Sessions API".
  const base = `agent:${agentId}:direct:${session.user.id!}`;
  const sessionKey = parsed.data.chatId ? `${base}:${parsed.data.chatId}` : base;

  // Throttle repeated compactions of the same session. The UI debounces via a
  // disabled button; this guards direct API spamming from fanning out
  // sessions.compact RPCs (compacting again seconds later is a no-op anyway).
  if (!allowCompaction(sessionKey)) {
    return NextResponse.json(
      {
        error: "You just compacted this conversation — please wait a moment before doing it again.",
      },
      { status: 429 }
    );
  }

  try {
    const client = getOpenClawClient();
    await client.sessions.compact(
      sessionKey,
      parsed.data.maxLines !== undefined ? { maxLines: parsed.data.maxLines } : undefined
    );
  } catch {
    // OpenClaw unreachable / mid-reconnect. 502 (not 500) so the client can
    // surface a retryable "couldn't compact" toast rather than a hard error.
    return NextResponse.json({ error: "Failed to compact session" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
});
