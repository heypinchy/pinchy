import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { openAdminOnlyAgentsToAll } from "@/lib/admin-only-agents";
import { deferAuditLog } from "@/lib/audit-deferred";
import { parseRequestBody } from "@/lib/api-validation";
import { openAdminOnlyAgentsSchema } from "@/lib/schemas/agents";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";

/**
 * Make admin-only shared agents visible to everyone (#1278).
 *
 * This widens access, so it is only ever an explicit admin action on agents
 * the admin named — never something a license activation does on its own. The
 * library re-checks "still restricted, still no group" in the UPDATE itself,
 * so an agent scoped to a group in the meantime is never widened.
 *
 * Each changed agent gets its own `agent.updated` row with the same
 * `changes.visibility` diff the Access tab writes, so the trail reads the same
 * whichever way an admin made the change.
 */
export const POST = withAdmin(async (request, _ctx, session) => {
  // Same gate as a visibility change on the Access tab: without a license
  // the setting cannot be managed (and on community it changes nothing).
  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const parsed = await parseRequestBody(openAdminOnlyAgentsSchema, request);
  if ("error" in parsed) return parsed.error;

  const opened = await openAdminOnlyAgentsToAll(parsed.data.agentIds);
  if (opened.length === 0) return NextResponse.json({ agents: [] });

  // The UPDATE has committed and cannot be rolled back, and a retry would find
  // nothing still admin-only — so every row is registered now, before the
  // Telegram follow-up can throw, and written after the response by
  // deferAuditLog, which records a failed write instead of losing it.
  for (const agent of opened) {
    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "agent.updated",
      resource: `agent:${agent.id}`,
      detail: {
        name: agent.name,
        changes: { visibility: { from: "restricted", to: "all" } },
      },
      outcome: "success",
    });
  }

  await recalculateTelegramAllowStores();

  return NextResponse.json({ agents: opened });
});
