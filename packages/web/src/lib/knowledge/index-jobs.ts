/**
 * The kb_index_jobs store: enqueue, claim, progress, finish (#714).
 *
 * The reindex route enqueues; the in-process worker
 * (src/server/kb-index-worker.ts) claims and runs. Two invariants live in the
 * database rather than here, because application checks cannot make them
 * atomic:
 *
 *   - At most one ACTIVE (pending|running) job per org, via the partial unique
 *     index `uq_kb_index_jobs_active`. enqueueIndexJob turns the resulting
 *     unique violation into an honest "busy" answer.
 *   - A job is claimed at most once, via a conditional UPDATE that pins
 *     `status = 'pending'` — the same claim shape as the email ledger
 *     (lib/email-workflows/ledger.ts), which this codebase already uses in
 *     place of row locks.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { kbIndexJobs } from "@/db/schema";
import { KB_INDEX_JOB_ACTIVE_STATUSES } from "@/db/enums";

import type { IngestResult } from "./types";

export type KbIndexJob = typeof kbIndexJobs.$inferSelect;

export interface EnqueueIndexJobArgs {
  orgId: string;
  agentId: string;
  /** Snapshotted onto the job so the completion audit row can name the agent even if it is renamed or deleted mid-run. */
  agentName: string;
  /** The actor id of the admin who asked. Carried onto the completion audit row so a background run is still attributable. */
  requestedBy: string;
  /** The agent's granted folders, already permission-narrowed by the caller. Snapshotted, never re-derived at run time. */
  paths: string[];
}

export type EnqueueIndexJobResult =
  /** The job was accepted and is waiting for the worker. */
  | { status: "queued"; job: KbIndexJob }
  /** The org already has a job in flight; `job` is that job, so the caller can point the admin at it instead of guessing. */
  | { status: "busy"; job: KbIndexJob };

/**
 * Enqueues an index run for one agent's granted folders, unless the org
 * already has one in flight.
 *
 * The busy check is the unique index, not a preceding SELECT: a check-then-
 * insert would let two admins clicking at once both pass the check and both
 * insert. Instead the insert itself is the check — `onConflictDoNothing`
 * returns a row only to the winner, the same claim shape claimEmail() uses —
 * and we look up the blocking job only once Postgres has told us we lost.
 */
export async function enqueueIndexJob(args: EnqueueIndexJobArgs): Promise<EnqueueIndexJobResult> {
  // Two attempts, not a retry loop: the second covers the one narrow race
  // where the blocking job finished between our rejected insert and the read
  // that looks for it. Repeating that race would need jobs to complete within
  // microseconds of each other, and a job takes minutes.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [job] = await db
      .insert(kbIndexJobs)
      .values({
        orgId: args.orgId,
        agentId: args.agentId,
        agentName: args.agentName,
        requestedBy: args.requestedBy,
        paths: args.paths,
      })
      .onConflictDoNothing()
      .returning();
    if (job) return { status: "queued", job };

    const active = await findActiveIndexJob(args.orgId);
    if (active) return { status: "busy", job: active };
    // The slot freed up between our rejected insert and this read — take it.
  }

  throw new Error(
    "Could not enqueue a knowledge-base index job: the org's active-job slot kept changing hands"
  );
}

/** The org's in-flight job, if any. */
export async function findActiveIndexJob(orgId: string): Promise<KbIndexJob | null> {
  const [job] = await db
    .select()
    .from(kbIndexJobs)
    .where(
      and(
        eq(kbIndexJobs.orgId, orgId),
        inArray(kbIndexJobs.status, [...KB_INDEX_JOB_ACTIVE_STATUSES])
      )
    )
    .limit(1);
  return job ?? null;
}

/**
 * Claims the oldest pending job for this worker, or returns null if there is
 * nothing to do.
 *
 * The `status = 'pending'` predicate in the UPDATE is what makes the claim
 * exclusive: an overlapping tick that reads the same id updates zero rows and
 * gets null, rather than running the same corpus twice.
 */
export async function claimNextIndexJob(): Promise<KbIndexJob | null> {
  const [next] = await db
    .select({ id: kbIndexJobs.id })
    .from(kbIndexJobs)
    .where(eq(kbIndexJobs.status, "pending"))
    .orderBy(asc(kbIndexJobs.createdAt))
    .limit(1);
  if (!next) return null;

  const [claimed] = await db
    .update(kbIndexJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(kbIndexJobs.id, next.id), eq(kbIndexJobs.status, "pending")))
    .returning();

  return claimed ?? null;
}

/**
 * Publishes how far the run has got and what it has found so far. Called once
 * per document; deliberately the only write on the hot path.
 *
 * Findings ride along with progress rather than waiting for the finish, for
 * two reasons. They answer the question an operator asks at the same moment as
 * "how far along?" — namely "is it going well?", and a run that is 200 files in
 * with 190 of them unsearchable is worth knowing about before the other 1800.
 * And it costs nothing: the UPDATE was already happening.
 */
export async function recordIndexJobProgress(
  jobId: string,
  progress: { processed: number; total: number; counts: IngestResult }
): Promise<void> {
  await db
    .update(kbIndexJobs)
    .set({ processed: progress.processed, total: progress.total, counts: progress.counts })
    .where(eq(kbIndexJobs.id, jobId));
}

export interface FinishIndexJobArgs {
  outcome: "succeeded" | "failed";
  /** The ingest's findings so far. Recorded on failure too — partial counts are the operator's only evidence of how far the run got. */
  counts: IngestResult;
  /** Scrubbed failure summary (safeProviderError). Omitted on success. */
  error?: string;
}

/** Moves a job to its terminal state, recording what it found. Releases the org's active-job slot. */
export async function finishIndexJob(jobId: string, args: FinishIndexJobArgs): Promise<void> {
  await db
    .update(kbIndexJobs)
    .set({
      status: args.outcome,
      counts: args.counts,
      error: args.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(kbIndexJobs.id, jobId));
}

/**
 * Returns `running` jobs to `pending` and returns how many were requeued.
 *
 * Called once at boot. Exactly one web container runs the worker, so a job
 * still marked `running` when the process starts belongs to a process that no
 * longer exists — nothing else could be holding it. Ingest is content-hash
 * idempotent, so resuming costs a re-discovery (almost everything skips) and
 * nothing more.
 *
 * Progress and findings are reset with the status: discovery re-runs from the
 * top, so leaving 30/42 on a run that restarted at zero would be the same
 * processed-isn't-real lie the counters exist to prevent — and leaving the dead
 * run's `indexed: 30` beside `processed: 0` would be a row contradicting
 * itself.
 */
export async function requeueOrphanedIndexJobs(): Promise<number> {
  const requeued = await db
    .update(kbIndexJobs)
    .set({ status: "pending", processed: 0, total: null, counts: null, startedAt: null })
    .where(eq(kbIndexJobs.status, "running"))
    .returning({ id: kbIndexJobs.id });
  return requeued.length;
}

/** The agent's most recent index job — running or last finished. Backs the status route. */
export async function getLatestIndexJobForAgent(agentId: string): Promise<KbIndexJob | null> {
  const [job] = await db
    .select()
    .from(kbIndexJobs)
    .where(eq(kbIndexJobs.agentId, agentId))
    .orderBy(desc(kbIndexJobs.createdAt))
    .limit(1);
  return job ?? null;
}
