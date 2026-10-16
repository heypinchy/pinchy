import { NextResponse } from "next/server";
import { withAdmin, withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";
import { getInstancePolicy, setInstancePolicy, type InstancePolicy } from "@/lib/instance-policy";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { instancePolicySchema } from "@/lib/schemas/governance";

/**
 * GET /api/settings/governance — the member-access switches. Readable by every
 * signed-in user: a member's UI needs them to explain an empty sidebar or a
 * paused automation, and they say nothing about anyone else.
 */
export const GET = withAuth(async () => {
  return NextResponse.json(await getInstancePolicy());
});

/**
 * PUT /api/settings/governance — set both switches. Admin-only, audited as
 * `settings.updated` with a from/to diff of what moved.
 *
 * The personal-agent switch also closes a door that does not pass through
 * Pinchy: Telegram routes a member's DMs straight to their Smithers inside
 * OpenClaw. So when it moves, the OpenClaw config (routing bindings) and the
 * Telegram allow stores are rebuilt — after the audit row, so a failing refresh
 * never leaves the change without a trail.
 */
export const PUT = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(instancePolicySchema, request);
  if ("error" in parsed) return parsed.error;
  const next: InstancePolicy = parsed.data;

  const previous = await getInstancePolicy();
  const changes: Record<string, { from: boolean; to: boolean }> = {};
  for (const key of Object.keys(next) as (keyof InstancePolicy)[]) {
    if (previous[key] !== next[key]) changes[key] = { from: previous[key], to: next[key] };
  }
  if (Object.keys(changes).length === 0) return NextResponse.json(next);

  await setInstancePolicy(next);

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "settings.updated",
    resource: "settings",
    detail: { changes },
    outcome: "success",
  });

  if (changes.memberPersonalAgents) {
    await regenerateOpenClawConfig();
    await recalculateTelegramAllowStores();
  }

  return NextResponse.json(next);
});
