/**
 * Builds (but never sends) `knowledge.reindex` audit entries.
 *
 * Shared by the two halves of an async reindex — the route that takes the
 * request and the worker that runs it hours later — so both halves cannot drift
 * into describing the same run differently. Callers pass the result straight to
 * deferAuditLog/appendAuditLog; the eslint pinchy/require-audit-log rule scans a
 * handler's source text for a literal call, so the send stays inline at each
 * call site rather than hiding behind a second indirection.
 */
import type { AuditLogEntry, EntityRef } from "@/lib/audit";

import type { IngestResult } from "./types";

/** The audit actorId the index worker signs its completion rows with (house pattern: actorType "system" + the job's name, cf. upload-gc). */
export const KB_INDEX_WORKER_ACTOR = "kb-index-worker";

export interface ReindexAuditArgs {
  /** "user" for the admin's request, "system" for the worker's outcome row. */
  actorType: "user" | "system";
  /** The admin's id on a request row; KB_INDEX_WORKER_ACTOR on an outcome row — the requesting admin is reachable from the request row via jobId. */
  actorId: string;
  agent: EntityRef;
  outcome: "success" | "failure";
  pathCount: number;
  /** Correlates the request row with the outcome row. Omitted where no job exists: nothing granted, or rejected before enqueue. */
  jobId?: string;
  /** The run's findings. Omitted on a request row — it has counted nothing yet, and zeros would report an empty corpus for every reindex ever started. */
  counts?: IngestResult;
  /** Scrubbed failure summary. Failure rows only. */
  reason?: string;
}

export function reindexAuditEntry(args: ReindexAuditArgs): AuditLogEntry {
  return {
    actorType: args.actorType,
    actorId: args.actorId,
    eventType: "knowledge.reindex",
    resource: `agent:${args.agent.id}`,
    outcome: args.outcome,
    detail: {
      agent: args.agent,
      pathCount: args.pathCount,
      ...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
      // Copied field by field rather than spread from `counts`: a spread would
      // put whatever IngestResult grows into onto an HMAC-signed row, and the
      // obvious next counter to want is a list of the paths that failed —
      // precisely the filesystem paths this detail must never carry (AGENTS.md
      // PII rule; see `pathCount`). Adding a counter here stays a decision.
      ...(args.counts !== undefined
        ? {
            indexed: args.counts.indexed,
            skipped: args.counts.skipped,
            removed: args.counts.removed,
            unsearchable: args.counts.unsearchable,
            failed: args.counts.failed,
          }
        : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
  };
}
