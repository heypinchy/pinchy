/**
 * The nightly knowledge-base reindex (plans/2026-10-16-kb-nightly-reindex-design.md).
 *
 * Once a night, at the time the admin set (default 02:00, org timezone), every
 * knowledge-base agent's granted folders are reindexed, so documents dropped
 * into the mounted folders during the day are searchable the next morning
 * without anyone pressing "Reindex now". Ingest is content-hash idempotent:
 * unchanged documents are skipped before extraction, so a night costs a read
 * of the corpus plus the work for what actually changed.
 *
 * This module only DECIDES and QUEUES. It never indexes: it enqueues ordinary
 * kb_index_jobs rows (trigger "scheduled") and the existing worker
 * (kb-index-worker.ts) runs them like any admin-requested job — same OCR
 * resolution, same PINCHY_KB_OCR switch, same audit. There is no second
 * indexing path to keep in step with the first.
 *
 * Queueing respects the one-active-job-per-org rule rather than changing it.
 * At the slot the scheduler snapshots the eligible agents into a sweep and
 * queues them ONE AT A TIME: each tick tries the head of the list, and a
 * "busy" answer (a run already holds the slot — the previous agent's, or an
 * admin's) means "try again next tick". So a manual reindex running at 02:00
 * delays the night instead of losing it, and an admin who clicks during the
 * night gets the route's usual 409 naming the scheduled run.
 *
 * In-process on a setInterval, like upload-gc / audit-verify-job / the index
 * worker: one web container, one scheduler. Not OpenClaw cron — that runs
 * agent turns, and a reindex is not one. Not a file watcher — inotify does not
 * fire on the CIFS/SMB mounts knowledge bases are usually served from.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { agents, kbIndexJobs } from "@/db/schema";
import { appendAuditLog, safeProviderError, type EntityRef } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { getOrgTimezone } from "@/lib/settings-timezone";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { enqueueIndexJob } from "@/lib/knowledge/index-jobs";
import { kbEmbedderAvailable } from "@/lib/knowledge/kb-embedder";
import {
  grantedKnowledgePaths,
  isScheduledIndexAgent,
  isSlotDue,
  latestPassedSlot,
  localClock,
  type IndexSchedule,
} from "@/lib/knowledge/index-schedule";
import {
  getIndexSchedule,
  getIndexScheduleState,
  saveIndexScheduleState,
  type IndexScheduleState,
  type IndexSweep,
} from "@/lib/knowledge/index-schedule-store";
import { KB_INDEX_SCHEDULER_ACTOR, reindexAuditEntry } from "@/lib/knowledge/reindex-audit";

export interface KbIndexSchedulerTickOptions {
  /** Test seam: the wall-clock moment the tick happens at. */
  now?: Date;
}

/** The eligible agents, oldest first — a stable order, so one night reads like the next. */
async function listScheduledIndexAgentIds(): Promise<string[]> {
  const rows = await db
    .select({
      id: agents.id,
      deletedAt: agents.deletedAt,
      isPersonal: agents.isPersonal,
      allowedTools: agents.allowedTools,
      pluginConfig: agents.pluginConfig,
    })
    .from(agents)
    .where(and(isNull(agents.deletedAt), eq(agents.isPersonal, false)))
    .orderBy(asc(agents.createdAt));
  return rows.filter(isScheduledIndexAgent).map((row) => row.id);
}

function sameSchedule(a: IndexSchedule | null, b: IndexSchedule): boolean {
  return a !== null && a.enabled === b.enabled && a.time === b.time;
}

/** Writes an audit row outside any request — the AGENTS.md non-request pattern. */
async function audit(entry: ReturnType<typeof reindexAuditEntry>): Promise<void> {
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }
}

type QueueOutcome = "queued" | "busy" | "skipped";

/**
 * Tries to queue one agent of the sweep.
 *
 * `queued` and `skipped` both mean "this agent is done for tonight"; only
 * `busy` leaves it at the head of the list.
 */
async function queueSweepAgent(sweep: IndexSweep, agentId: string): Promise<QueueOutcome> {
  // A job for this agent in this sweep is the evidence that it was queued —
  // even if the bookkeeping that should have recorded it never got written
  // because the process died in between. Without this check that crash would
  // index the agent twice in one night.
  const [already] = await db
    .select({ id: kbIndexJobs.id })
    .from(kbIndexJobs)
    .where(and(eq(kbIndexJobs.sweepId, sweep.id), eq(kbIndexJobs.agentId, agentId)))
    .limit(1);
  if (already) return "skipped";

  // Re-read rather than trusting the snapshot: an agent deleted, renamed or
  // stripped of its folders since the sweep started is indexed as it is now.
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      deletedAt: agents.deletedAt,
      isPersonal: agents.isPersonal,
      allowedTools: agents.allowedTools,
      pluginConfig: agents.pluginConfig,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent || !isScheduledIndexAgent(agent)) return "skipped";

  const agentRef: EntityRef = { id: agent.id, name: agent.name };
  const paths = grantedKnowledgePaths(agent.pluginConfig);
  const base = {
    actorType: "system" as const,
    actorId: KB_INDEX_SCHEDULER_ACTOR,
    agent: agentRef,
    pathCount: paths.length,
    trigger: "scheduled" as const,
    sweepId: sweep.id,
  };

  // The route's precheck, for the route's reason: a job that can only fail is
  // worse than saying so now. Repeated every night until the image is fixed —
  // a broken knowledge base should keep saying it is broken.
  if (!kbEmbedderAvailable()) {
    await audit(
      reindexAuditEntry({ ...base, outcome: "failure", reason: "embedding_model_missing" })
    );
    return "skipped";
  }

  let enqueued;
  try {
    enqueued = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: KB_INDEX_SCHEDULER_ACTOR,
      paths,
      trigger: "scheduled",
      sweepId: sweep.id,
    });
  } catch (err) {
    // Recorded and skipped for tonight rather than retried every minute: an
    // enqueue that throws is a database problem, and a retry loop would write
    // a failure row per tick for as long as it lasts.
    await audit(
      reindexAuditEntry({
        ...base,
        outcome: "failure",
        reason: safeProviderError(err instanceof Error ? err.message : "enqueue_failed"),
      })
    );
    return "skipped";
  }
  if (enqueued.status === "busy") return "busy";

  await audit(reindexAuditEntry({ ...base, outcome: "success", jobId: enqueued.job.id }));
  return "queued";
}

/**
 * Starts a sweep when tonight's slot is due, and queues the next agent of the
 * sweep in progress when the instance's job slot is free.
 */
async function advance(now: Date): Promise<void> {
  const schedule = await getIndexSchedule();
  const clock = localClock(now, await getOrgTimezone());
  let state: IndexScheduleState = await getIndexScheduleState();

  // First tick ever, a corrupt state row, or a schedule the admin changed
  // since the slot was taken: the slot that has ALREADY passed counts as
  // taken. Otherwise an upgrade at 10:00, or switching the schedule back on at
  // 14:00, would start a full walk of every knowledge base mid-day.
  if (state.lastSlot === null || !sameSchedule(state.schedule, schedule)) {
    state = { ...state, lastSlot: latestPassedSlot(clock, schedule), schedule };
    // Switching the schedule off also drops the agents still waiting tonight.
    // The job already running finishes; an interrupted run is worth less.
    if (!schedule.enabled) state = { ...state, sweep: null };
    await saveIndexScheduleState(state);
  }

  // A sweep still draining at the next slot is not restarted: the night it
  // belongs to is not over until its agents are, and the next one starts the
  // moment it drains (the slot is then simply due).
  if (state.sweep === null && isSlotDue(clock, schedule, state.lastSlot!)) {
    const agentIds = await listScheduledIndexAgentIds();
    state = {
      ...state,
      lastSlot: latestPassedSlot(clock, schedule),
      sweep: {
        id: randomUUID(),
        slot: latestPassedSlot(clock, schedule),
        startedAt: now.toISOString(),
        agentCount: agentIds.length,
        pending: agentIds,
      },
    };
    await saveIndexScheduleState(state);
  }

  const sweep = state.sweep;
  if (sweep === null) return;

  while (sweep.pending.length > 0) {
    const outcome = await queueSweepAgent(sweep, sweep.pending[0]);
    if (outcome === "busy") return;
    sweep.pending.shift();
    await saveIndexScheduleState(state);
    // The one active-job slot is ours now; the next agent waits for it.
    if (outcome === "queued") break;
  }

  if (sweep.pending.length === 0) {
    const { pending: _done, ...finished } = sweep;
    await saveIndexScheduleState({ ...state, sweep: null, lastSweep: finished });
  }
}

/**
 * How often to look at the clock. A minute is the schedule's resolution, and
 * an idle tick is three settings reads.
 */
const TICK_INTERVAL_MS = 60_000;

let _tickInterval: ReturnType<typeof setInterval> | null = null;
// Re-entrancy guard: a tick waiting on a slow database must not overlap the
// next one, or both could start the same sweep.
let _tickInFlight = false;

/** One look at the clock. Exported for tests; the interval calls it. */
export async function runKbIndexSchedulerTick(
  opts: KbIndexSchedulerTickOptions = {}
): Promise<void> {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    await advance(opts.now ?? new Date());
  } catch (err) {
    console.error("[kb-index-scheduler] tick failed:", err);
  } finally {
    _tickInFlight = false;
  }
}

export function startKbIndexScheduler(): void {
  _tickInterval = setInterval(() => {
    void runKbIndexSchedulerTick();
  }, TICK_INTERVAL_MS);
}

export function stopKbIndexScheduler(): void {
  if (_tickInterval !== null) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
}

// Test-only helper (mirrors kb-index-worker / upload-gc).
export function _isKbIndexSchedulerRunning(): boolean {
  return _tickInterval !== null;
}

/** Test-only: returns the module to its just-booted state. */
export function _resetKbIndexSchedulerForTest(): void {
  _tickInFlight = false;
}
