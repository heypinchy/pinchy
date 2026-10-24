import { NextResponse } from "next/server";

import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";
import { knowledgeIndexScheduleSchema } from "@/lib/schemas/knowledge-base";
import {
  getIndexSchedule,
  getIndexScheduleStatus,
  saveIndexSchedule,
} from "@/lib/knowledge/index-schedule-store";

/**
 * GET /api/settings/knowledge-index-schedule — whether Pinchy reindexes every
 * knowledge-base agent on its own once a night, when it runs next, and what
 * the last nights did. Admin-only, like every knowledge-base management
 * surface.
 */
// Read-only projection — outside require-audit-log's scope (POST/PUT/PATCH/DELETE).
export const GET = withAdmin(async () => {
  return NextResponse.json(await getIndexScheduleStatus());
});

/**
 * PUT /api/settings/knowledge-index-schedule — sets the nightly reindex.
 *
 * Takes effect from the next occurrence of the new time, never retroactively:
 * the scheduler notices the change and counts the slot that has already passed
 * as taken (src/server/kb-index-scheduler.ts). So switching it back on at
 * 14:00 does not start a full walk of every knowledge base mid-afternoon.
 */
export const PUT = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(knowledgeIndexScheduleSchema, request);
  if ("error" in parsed) return parsed.error;
  const next = { enabled: parsed.data.enabled, time: parsed.data.time };

  const previous = await getIndexSchedule();
  await saveIndexSchedule(next);

  // Only when something changed, like the timezone setting: a no-op save is
  // not a decision, and a from===to row would bury the ones that are.
  // Switching this off decides whether new documents ever become searchable
  // on their own, so the trail records who did it and what it was before.
  if (previous.enabled !== next.enabled || previous.time !== next.time) {
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "settings.updated",
      resource: "settings:knowledge_index_schedule",
      detail: { changes: { knowledgeIndexSchedule: { from: previous, to: next } } },
      outcome: "success",
    });
  }

  return NextResponse.json(await getIndexScheduleStatus());
});
