import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { pollForToken } from "@pinchy/openai-subscription-oauth";
import { getPendingFlow, deletePendingFlow, OPENAI_CODEX_POLL_URL } from "@/lib/openai-oauth-state";
import { setOpenAiSubscription } from "@/lib/openai-subscription";
import { getSetting, deleteSetting } from "@/lib/settings";
import { PROVIDERS } from "@/lib/providers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { appendAuditLog } from "@/lib/audit";
import { migrateAgentsToCodex } from "@/lib/openai-model-migration";

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const { flowId } = (await request.json()) as { flowId?: string };
  if (!flowId) return NextResponse.json({ error: "flowId required" }, { status: 400 });

  const flow = getPendingFlow(flowId);
  if (!flow) return NextResponse.json({ error: "flow expired or unknown" }, { status: 410 });

  try {
    const tokens = await pollForToken({
      deviceCode: flow.deviceCode,
      clientId: flow.clientId,
      intervalSeconds: 0,
      endpoint: OPENAI_CODEX_POLL_URL,
      maxAttempts: 1,
    });

    // Hard-exclusive: remove existing API key if present
    const existingApiKey = await getSetting(PROVIDERS.openai.settingsKey);
    if (existingApiKey) {
      await deleteSetting(PROVIDERS.openai.settingsKey);
      await appendAuditLog({
        actorType: "user",
        actorId: session.user.id,
        eventType: "config.changed",
        resource: "settings:openai_api_key",
        outcome: "success",
        detail: {
          event: "api_key_removed",
          provider: "openai",
          reason: "switched_to_subscription",
        },
      });
    }

    await setOpenAiSubscription({
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt: new Date(tokens.expires).toISOString(),
      accountId: tokens.accountId,
      accountEmail: tokens.accountEmail,
      connectedAt: new Date().toISOString(),
      refreshFailureCount: 0,
    });

    await regenerateOpenClawConfig();
    const migrated = await migrateAgentsToCodex();

    // Only delete the pending flow after all storage operations have succeeded,
    // so the user can retry if storage fails mid-way.
    deletePendingFlow(flowId);

    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id,
      eventType: "config.changed",
      resource: "settings:openai_subscription",
      outcome: "success",
      detail: {
        event: "subscription_connected",
        provider: "openai",
        accountId: tokens.accountId,
        accountEmail: tokens.accountEmail,
      },
    });

    return NextResponse.json({
      status: "complete",
      accountEmail: tokens.accountEmail,
      accountId: tokens.accountId,
      migratedAgents: migrated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("authorization_pending") || message.includes("slow_down")) {
      return NextResponse.json({ status: "pending" });
    }

    deletePendingFlow(flowId);

    const reason = message.includes("access_denied")
      ? "access_denied"
      : message.includes("expired_token")
        ? "expired_token"
        : "unknown";

    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id,
      eventType: "config.changed",
      resource: "settings:openai_subscription",
      outcome: "failure",
      error: { message },
      detail: { event: "subscription_connect_failed", reason },
    });

    return NextResponse.json({ status: "failed", reason });
  }
}
