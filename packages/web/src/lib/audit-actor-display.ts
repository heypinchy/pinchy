/**
 * The name the audit trail shows for an actor (#1271).
 *
 * Read side only. The row keeps the raw `actorId` it was written with — for a
 * user that is the pseudonym `resolveActorId` chose, for an agent the agent id,
 * for a system job the job's name — and nothing here writes anything back.
 * Names are joined in at read time (`auditSelectWithJoins`), so a renamed agent
 * shows its current name and an erased user shows no name at all.
 */
import { apiKeyActorName } from "@/lib/api-key-identity";
import { KB_INDEX_SCHEDULER_ACTOR, KB_INDEX_WORKER_ACTOR } from "@/lib/knowledge/reindex-audit";

/**
 * Readable labels for the `actorId`s that `actorType: "system"` rows carry.
 *
 * `system-actor-labels-drift.test.ts` scans the source for every literal
 * system actorId and fails until it has an entry here. An id that reaches the
 * table without one still reads as itself, untruncated — never as `kb-index…`.
 */
export const SYSTEM_ACTOR_LABELS: Readonly<Record<string, string>> = {
  system: "System",
  [KB_INDEX_SCHEDULER_ACTOR]: "Scheduled reindex",
  [KB_INDEX_WORKER_ACTOR]: "Knowledge base indexer",
  "upload-gc": "Upload cleanup",
  "chat-error-gc": "Chat error cleanup",
  "approval-sweep": "Approval expiry",
  "audit-verify-job": "Audit verification",
  "budget-monitor": "Budget monitor",
  "channel-media-mirror": "Channel media mirror",
  "channel-watchdog": "Channel watchdog",
  watchdog: "Chat run watchdog",
  "inbox-sweep": "Inbox sweep",
};

export function systemActorLabel(actorType: string, actorId: string): string | null {
  if (actorType !== "system") return null;
  return Object.hasOwn(SYSTEM_ACTOR_LABELS, actorId) ? SYSTEM_ACTOR_LABELS[actorId] : actorId;
}

/** The joined columns `auditSelectWithJoins` returns for the actor. */
export interface ActorDisplayInput {
  actorType: string;
  actorId: string;
  detail: unknown;
  actorName: string | null;
  actorBanned: boolean | null;
  actorAgentName: string | null;
  actorAgentDeletedAt: Date | null;
}

export function resolveActorDisplay(row: ActorDisplayInput): {
  actorName: string | null;
  actorDeleted: boolean;
} {
  if (row.actorType === "agent") {
    return { actorName: row.actorAgentName, actorDeleted: !!row.actorAgentDeletedAt };
  }
  return {
    actorName:
      row.actorName ??
      apiKeyActorName(row.actorType, row.detail) ??
      systemActorLabel(row.actorType, row.actorId),
    actorDeleted: !!row.actorBanned,
  };
}
