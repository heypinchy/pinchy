import { NextResponse, type NextRequest } from "next/server";
import { restartState } from "@/server/restart-state";
import { openClawConnectionState } from "@/server/openclaw-connection-state";
import { getOpenClawClient } from "@/server/openclaw-client";
import { classifyChannelStatus, type ChannelAccountHealth } from "@/server/channel-health";

/**
 * GET `/api/health/openclaw[?agentId=<uuid>]`
 *
 * Default mode: returns `{ status, connected }` — cheap synchronous check
 * used by browser status indicators and CI stability gates.
 *
 * With `?agentId=<uuid>`: additionally queries OpenClaw's runtime config
 * (`config.get`) and returns `{ ..., agentDispatchable: boolean }`. True iff
 * OC's `agents.list` currently contains the requested id, i.e. dispatching
 * a chat to that agent right now would NOT fail with "unknown agent id".
 *
 * The query mode exists to close the race window after `PATCH /api/agents/:id`
 * or `PUT /api/agents/:id/integrations` returns 200: those endpoints fire
 * `regenerateOpenClawConfig()` as fire-and-forget, so the hot-reload can
 * still be in flight when the response lands. E2E tests use this endpoint
 * to poll until the agent is actually dispatchable before sending a chat
 * (otherwise the dispatch races the config-apply and intermittently hits
 * the "unknown agent id" path — see the Odoo dispatch probe in
 * `e2e/odoo/odoo-agent-chat.spec.ts`).
 *
 * Safe to expose publicly: only checks for presence of the id in
 * `agents.list`, returns no agent metadata.
 */
export async function GET(request: NextRequest) {
  if (restartState.isRestarting) {
    return NextResponse.json({
      status: "restarting",
      connected: false,
      since: restartState.triggeredAt,
    });
  }

  const base = { status: "ok" as const, connected: openClawConnectionState.connected };

  // With `?channelHealth=1`: a LIVE per-account channel-health snapshot from
  // `channels.status()`, used by the admin Telegram settings UI to show a
  // "degraded" badge. The watchdog (server.ts) owns the auditing; this is the
  // current display state. All failure modes collapse to `[]` so the poll
  // never breaks with a 5xx.
  if (request.nextUrl.searchParams.get("channelHealth")) {
    let channelHealth: ChannelAccountHealth[] = [];
    try {
      const client = getOpenClawClient();
      channelHealth = classifyChannelStatus(await client.channels.status());
    } catch {
      channelHealth = [];
    }
    return NextResponse.json({ ...base, channelHealth });
  }

  const agentId = request.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json(base);
  }

  // Agent-dispatchable probe. Failure modes (OC not connected, config.get
  // RPC throws, list missing) all collapse to `agentDispatchable: false` so
  // the poll keeps trying — never breaks the test loop with a 5xx.
  let agentDispatchable = false;
  try {
    const client = getOpenClawClient();
    const result = (await client.config.get()) as {
      config?: { agents?: { list?: Array<{ id?: string }> } };
    };
    const list = result?.config?.agents?.list ?? [];
    agentDispatchable = list.some((a) => a?.id === agentId);
  } catch {
    agentDispatchable = false;
  }
  return NextResponse.json({ ...base, agentDispatchable });
}
