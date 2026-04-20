import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getOpenAiSubscription, deleteOpenAiSubscription } from "@/lib/openai-subscription";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { appendAuditLog } from "@/lib/audit";
import { migrateAgentsToApiKey } from "@/lib/openai-model-migration";

export async function GET() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const current = await getOpenAiSubscription();
  if (!current) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    accountEmail: current.accountEmail,
    connectedAt: current.connectedAt,
    refreshFailureCount: current.refreshFailureCount,
  });
}

export async function DELETE() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const current = await getOpenAiSubscription();
  if (!current) {
    return NextResponse.json({ error: "No active subscription" }, { status: 404 });
  }

  await deleteOpenAiSubscription();
  await regenerateOpenClawConfig();
  const migrated = await migrateAgentsToApiKey();

  void appendAuditLog({
    actorType: "user",
    actorId: session.user.id,
    eventType: "config.changed",
    resource: "settings:openai_subscription",
    outcome: "success",
    detail: {
      event: "subscription_disconnected",
      provider: "openai",
      accountId: current.accountId,
      accountEmail: current.accountEmail,
    },
  });

  return NextResponse.json({ success: true, migratedAgents: migrated });
}
