import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { removeGatedConfig } from "@/lib/gated-config";
import { appendAuditLog } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";

/** Cap list snapshots so the audit detail stays under the 2048-byte budget. */
const SNAPSHOT_CAP = 20;

/**
 * "Remove all license-gated configuration" — the audited escape hatch back
 * to community semantics (pricing concept § 5, carve-out 2). Only available
 * while no license is active: with an active license this would just be
 * regular (gated) management.
 */
export async function DELETE() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  if (await isEnterprise()) {
    return NextResponse.json(
      {
        error: "License is active",
        message: "Gated configuration can be managed normally while a license is active.",
      },
      { status: 409 }
    );
  }

  const removed = await removeGatedConfig();

  // Audit immediately after the mutation, BEFORE any follow-up plumbing —
  // a telegram-recalc failure must not leave an access-widening action
  // without a trail.
  const truncated = removed.groups.length > SNAPSHOT_CAP || removed.agents.length > SNAPSHOT_CAP;
  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.gated_config_removed",
    detail: {
      groupsRemoved: removed.groups.length,
      agentsReset: removed.agents.length,
      groups: removed.groups.slice(0, SNAPSHOT_CAP),
      agents: removed.agents.slice(0, SNAPSHOT_CAP),
      truncated,
    },
    outcome: "success",
  });

  await recalculateTelegramAllowStores();

  return NextResponse.json({
    groupsRemoved: removed.groups.length,
    agentsReset: removed.agents.length,
  });
}
