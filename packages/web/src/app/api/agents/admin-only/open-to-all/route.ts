import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { openAdminOnlyAgentsToAll } from "@/lib/admin-only-agents";
import { appendAuditLog } from "@/lib/audit";
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

  // Audit right after the write and before the Telegram follow-up: a recalc
  // failure must not leave an access-widening change without a trail.
  for (const agent of opened) {
    await appendAuditLog({
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
