/**
 * Where the nightly reindex keeps its setting and its bookkeeping.
 *
 * Two settings rows, deliberately separate:
 *
 *   - `knowledge.index_schedule` is what the admin chose ({ enabled, time }).
 *   - `knowledge.index_schedule_state` is what the scheduler has done: the
 *     last slot it took, and the sweep it is working through.
 *
 * The state is persisted rather than held in memory because the two things it
 * remembers must survive a restart: a sweep that was halfway through its
 * agents when the container restarted has to finish them, and a night that
 * already ran must not run again because the process came back at 03:00.
 *
 * One web container runs the scheduler (the same assumption the index worker
 * makes), so read-modify-write on this row needs no lock.
 */
import { getSetting, setSetting } from "@/lib/settings";
import { getOrgTimezone } from "@/lib/settings-timezone";

import {
  localClock,
  nextIndexRun,
  parseIndexSchedule,
  type IndexSchedule,
  type IndexScheduleStatus,
} from "./index-schedule";

const SCHEDULE_KEY = "knowledge.index_schedule";
const STATE_KEY = "knowledge.index_schedule_state";

/** One night's run across every knowledge-base agent. */
export interface IndexSweep {
  /** Stamped on every job and audit row of this sweep. */
  id: string;
  /** The org-local date the sweep is for. */
  slot: string;
  startedAt: string;
  /** How many agents the sweep set out to reindex. */
  agentCount: number;
  /** Agents not yet queued, in order. The head is queued as soon as the instance's one job slot is free. */
  pending: string[];
}

export interface IndexScheduleState {
  /** The most recent slot taken, as an org-local date. Null before the scheduler's first tick. */
  lastSlot: string | null;
  /**
   * The schedule `lastSlot` was taken against. When the admin's setting no
   * longer matches it, the scheduler re-takes the slot that has already
   * passed under the NEW setting — that is what keeps switching the schedule
   * back on, or moving its time, from firing a run on the spot.
   */
  schedule: IndexSchedule | null;
  /** The sweep in progress, if any. */
  sweep: IndexSweep | null;
  /** The most recent sweep that queued all its agents. Shown to admins; never read back by the scheduler. */
  lastSweep: Omit<IndexSweep, "pending"> | null;
}

const EMPTY_STATE: IndexScheduleState = {
  lastSlot: null,
  schedule: null,
  sweep: null,
  lastSweep: null,
};

export async function getIndexSchedule(): Promise<IndexSchedule> {
  return parseIndexSchedule(await getSetting(SCHEDULE_KEY));
}

export async function saveIndexSchedule(schedule: IndexSchedule): Promise<void> {
  await setSetting(
    SCHEDULE_KEY,
    JSON.stringify({ enabled: schedule.enabled, time: schedule.time })
  );
}

/**
 * Reads the scheduler's bookkeeping. Anything unreadable comes back empty,
 * which the scheduler treats like a first boot: the slot that has already
 * passed counts as taken. A corrupt row therefore costs one night at most —
 * never a run in the middle of the day, and never a scheduler that is stuck.
 */
export async function getIndexScheduleState(): Promise<IndexScheduleState> {
  const raw = await getSetting(STATE_KEY);
  if (raw === null) return { ...EMPTY_STATE };
  try {
    const value = JSON.parse(raw) as Partial<IndexScheduleState> | null;
    if (typeof value !== "object" || value === null) return { ...EMPTY_STATE };
    return {
      lastSlot: typeof value.lastSlot === "string" ? value.lastSlot : null,
      schedule:
        value.schedule && typeof value.schedule === "object"
          ? parseIndexSchedule(JSON.stringify(value.schedule))
          : null,
      sweep: isSweep(value.sweep) ? value.sweep : null,
      lastSweep: value.lastSweep && typeof value.lastSweep === "object" ? value.lastSweep : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function saveIndexScheduleState(state: IndexScheduleState): Promise<void> {
  await setSetting(STATE_KEY, JSON.stringify(state));
}

function isSweep(value: unknown): value is IndexSweep {
  if (typeof value !== "object" || value === null) return false;
  const sweep = value as Partial<IndexSweep>;
  return (
    typeof sweep.id === "string" &&
    typeof sweep.slot === "string" &&
    typeof sweep.startedAt === "string" &&
    typeof sweep.agentCount === "number" &&
    Array.isArray(sweep.pending) &&
    sweep.pending.every((id) => typeof id === "string")
  );
}

export async function getIndexScheduleStatus(now: Date = new Date()): Promise<IndexScheduleStatus> {
  const [schedule, timezone, state] = await Promise.all([
    getIndexSchedule(),
    getOrgTimezone(),
    getIndexScheduleState(),
  ]);
  return {
    ...schedule,
    timezone,
    nextRun: nextIndexRun(localClock(now, timezone), schedule),
    currentSweep: state.sweep
      ? {
          slot: state.sweep.slot,
          startedAt: state.sweep.startedAt,
          agentCount: state.sweep.agentCount,
          waiting: state.sweep.pending.length,
        }
      : null,
    lastSweep: state.lastSweep
      ? {
          slot: state.lastSweep.slot,
          startedAt: state.lastSweep.startedAt,
          agentCount: state.lastSweep.agentCount,
        }
      : null,
  };
}
