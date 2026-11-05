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
 * The drift guard in `__tests__/lib/audit-actor-display.test.ts` scans
 * `src/` and `server.ts` for system actor ids written as a string literal, a
 * constant or a `prefix:${…}` template, and fails until each has an entry
 * here or in SYSTEM_ACTOR_PREFIX_LABELS. An id computed any other way is not
 * seen; it still reads as itself, untruncated — never as `kb-index…`.
 */
export const SYSTEM_ACTOR_LABELS: Readonly<Record<string, string>> = {
  system: "System",
  [KB_INDEX_SCHEDULER_ACTOR]: "Scheduled reindex",
  [KB_INDEX_WORKER_ACTOR]: "Knowledge base indexer",
  "upload-gc": "Upload cleanup",
  "chat-error-gc": "Chat error cleanup",
  "approval-sweep": "Approval sweep",
  "audit-verify-job": "Audit verification",
  "budget-monitor": "Budget monitor",
  "channel-media-mirror": "Channel media mirror",
  "channel-watchdog": "Channel watchdog",
  watchdog: "Chat run watchdog",
  "inbox-sweep": "Inbox sweep",
  "invite-claim": "Invite claim",
};

/** Labels for system actor ids of the form `<prefix><name>`, e.g. `plugin:pinchy-odoo`. */
export const SYSTEM_ACTOR_PREFIX_LABELS: Readonly<Record<string, string>> = {
  "plugin:": "Plugin",
};

export function systemActorLabel(actorType: string, actorId: string): string | null {
  if (actorType !== "system") return null;
  if (Object.hasOwn(SYSTEM_ACTOR_LABELS, actorId)) return SYSTEM_ACTOR_LABELS[actorId];
  for (const [prefix, label] of Object.entries(SYSTEM_ACTOR_PREFIX_LABELS)) {
    if (actorId.startsWith(prefix) && actorId.length > prefix.length) {
      return `${label} ${actorId.slice(prefix.length)}`;
    }
  }
  return actorId;
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
