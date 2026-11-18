/**
 * When the knowledge base reindexes itself: the nightly schedule's pure logic.
 *
 * Kept free of the database so the arithmetic that decides "is it time?" can
 * be tested against real timezones and real clock changes without a clock or a
 * Postgres in the loop. The scheduler (src/server/kb-index-scheduler.ts) reads
 * the setting and the state, asks this module, and acts.
 *
 * A slot is a LOCAL CALENDAR DATE in the org timezone, never an instant. A
 * slot is due once the org-local time of day has reached the scheduled time
 * on a date later than the last slot taken. That one decision is what makes
 * daylight-saving a non-event: on the spring-forward night 02:00 never
 * happens, but 03:00 ≥ 02:00, so the slot is due; on the fall-back night 02:00
 * happens twice, but both are the same date, so it runs once. Converting
 * "02:00 in Vienna" to UTC would have to answer questions that have no good
 * answer on exactly those two nights.
 *
 * It also makes catch-up fall out for free: if Pinchy was down at 02:00 and
 * starts at 07:00, the latest passed slot is still today's and has not been
 * taken, so it runs now. Only the latest missed night is caught up — the
 * question is "is the index current?", not "did every night run?".
 */

import type { AgentPluginConfig } from "@/db/schema";
import { grantedDataPaths } from "@/lib/agent-granted-paths";

export interface IndexSchedule {
  /** Whether Pinchy reindexes on its own. */
  enabled: boolean;
  /** Org-local time of day, 24-hour "HH:MM". */
  time: string;
}

/**
 * On by default, nightly at 02:00. On because the promise is that new
 * documents become searchable with nobody doing anything — an opt-in would be
 * one more thing to do, and the thing nobody remembers to do.
 */
export const DEFAULT_INDEX_SCHEDULE: IndexSchedule = { enabled: true, time: "02:00" };

/** A 24-hour "HH:MM". Shared with the request schema so the route and this parser accept exactly the same values. */
export const INDEX_SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether `a` is the same setting as `b` — the test for "the admin changed the schedule since the slot was taken". */
export function sameIndexSchedule(a: IndexSchedule | null, b: IndexSchedule): boolean {
  return a !== null && a.enabled === b.enabled && a.time === b.time;
}

/** The org-local calendar date ("YYYY-MM-DD") and minutes since local midnight. */
export interface LocalClock {
  date: string;
  minutes: number;
}

/**
 * Reads a stored schedule, falling back to the default for anything it cannot
 * read.
 *
 * Falling back to ON, deliberately. A corrupt value that quietly switched the
 * schedule off would be the one failure nobody notices — until somebody asks
 * about a document that arrived last week.
 */
export function parseIndexSchedule(raw: string | null): IndexSchedule {
  if (raw === null) return { ...DEFAULT_INDEX_SCHEDULE };
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { enabled?: unknown }).enabled === "boolean" &&
      typeof (value as { time?: unknown }).time === "string" &&
      INDEX_SCHEDULE_TIME_PATTERN.test((value as { time: string }).time)
    ) {
      const { enabled, time } = value as IndexSchedule;
      return { enabled, time };
    }
  } catch {
    // Unparseable — same answer as an unrecognised shape, below.
  }
  return { ...DEFAULT_INDEX_SCHEDULE };
}

/** The wall clock in `timeZone` at `now`. */
export function localClock(now: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // h23, not `hour12: false`: the latter formats midnight as "24" on some
    // runtimes, which reads as minute 1440 of the PREVIOUS day.
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Shifts a "YYYY-MM-DD" by whole days. Calendar arithmetic only — done in UTC so no clock change can move it. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The most recent slot whose time has arrived, as of `clock`: today once the time is reached, yesterday before it. */
export function latestPassedSlot(clock: LocalClock, schedule: IndexSchedule): string {
  return clock.minutes >= minutesOf(schedule.time) ? clock.date : shiftDate(clock.date, -1);
}

/**
 * Whether a sweep should start now.
 *
 * `lastSlot` is the slot most recently taken. ISO dates compare correctly as
 * strings, so "a later date than the last one taken" is a string comparison.
 */
export function isSlotDue(clock: LocalClock, schedule: IndexSchedule, lastSlot: string): boolean {
  return schedule.enabled && latestPassedSlot(clock, schedule) > lastSlot;
}

export interface NextIndexRun {
  /** Org-local date of the next run. */
  date: string;
  /** Org-local time of the next run, "HH:MM". */
  time: string;
  /** Relative to the org-local date now; the next slot is always one of the two. */
  day: "today" | "tomorrow";
  /**
   * The same run as an instant (ISO 8601, UTC) — what a viewer needs to read
   * it in their own time, the way every other timestamp in the app is shown.
   * See slotInstant for the nights the clock changes.
   */
  at: string;
}

/**
 * What an admin is shown about the nightly reindex: the setting, when it runs
 * next, and what the last nights did. Times are org-local wall-clock values
 * with the zone beside them — the same anchoring every scheduled thing in
 * Pinchy uses — so two admins in different places read the same answer.
 */
export interface IndexScheduleStatus extends IndexSchedule {
  timezone: string;
  nextRun: NextIndexRun | null;
  /** The sweep still queueing agents; `waiting` counts the agents not yet queued. */
  currentSweep: { slot: string; startedAt: string; agentCount: number; waiting: number } | null;
  /** The most recent sweep that queued all its agents. Their outcomes are on each agent's Index section. */
  lastSweep: { slot: string; startedAt: string; agentCount: number } | null;
}

/**
 * The next slot ahead of `clock` (read in `timeZone`), or null while the
 * schedule is off.
 *
 * `lastSlot` is the slot the scheduler took last. It matters on one night: on
 * the fall-back night a slot inside the repeated hour (02:30 in Vienna) runs,
 * the clock goes back, and the local time is before the slot again for half
 * an hour. Today's slot is taken then, so the next run is tomorrow's — not an
 * `at` already in the past.
 */
export function nextIndexRun(
  clock: LocalClock,
  schedule: IndexSchedule,
  timeZone: string,
  lastSlot: string | null
): NextIndexRun | null {
  if (!schedule.enabled) return null;
  const today = clock.minutes < minutesOf(schedule.time) && lastSlot !== clock.date;
  const date = today ? clock.date : shiftDate(clock.date, 1);
  return {
    date,
    time: schedule.time,
    day: today ? "today" : "tomorrow",
    at: slotInstant(date, schedule.time, timeZone).toISOString(),
  };
}

const MINUTE_MS = 60_000;

/**
 * The instant a slot is due: the first moment the org-local clock on `date`
 * reaches `time` — the rule isSlotDue applies, so the two agree on the nights
 * the clock changes. On the spring-forward night a time inside the gap is due
 * when the clock lands after it (02:30 in Vienna is 03:00 CEST); on the
 * fall-back night a time that happens twice is due the first time.
 *
 * The zone's offset is read a day either side of the slot, which brackets
 * any transition near it. Converting the wall-clock reading with each offset
 * gives the candidates; one whose local clock reads exactly the slot is a real
 * occurrence, and the earlier one wins (the fall-back night). When neither
 * does, the slot fell into a spring-forward gap, the local clock only moves
 * forward between the two candidates, and the earliest minute there that has
 * reached the slot is the answer. Offsets are whole minutes everywhere, so
 * minute steps are exact.
 */
export function slotInstant(date: string, time: string, timeZone: string): Date {
  const target = minutesOf(time);
  const [y, m, d] = date.split("-").map(Number);
  // The slot's wall-clock reading, as if it were UTC.
  const wall = Date.UTC(y, m - 1, d) + target * MINUTE_MS;
  const offsetAt = (instant: number): number => {
    const clock = localClock(new Date(instant), timeZone);
    const [cy, cm, cd] = clock.date.split("-").map(Number);
    return Date.UTC(cy, cm - 1, cd) + clock.minutes * MINUTE_MS - instant;
  };
  const day = 24 * 60 * MINUTE_MS;
  const candidates = [wall - offsetAt(wall - day), wall - offsetAt(wall + day)].sort(
    (p, q) => p - q
  );

  for (const instant of candidates) {
    const clock = localClock(new Date(instant), timeZone);
    if (clock.date === date && clock.minutes === target) return new Date(instant);
  }

  const reached = (instant: number): boolean => {
    const clock = localClock(new Date(instant), timeZone);
    return clock.date > date || (clock.date === date && clock.minutes >= target);
  };
  let lo = candidates[0];
  let hi = candidates[1];
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (reached(mid)) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** The fields of an agent row that decide whether the nightly sweep reindexes it. */
export interface ScheduledIndexCandidate {
  deletedAt: Date | null;
  allowedTools: string[];
  pluginConfig: AgentPluginConfig | null;
}

/**
 * The folders an agent is granted — the same source the reindex route and the
 * search route scope by. Entries outside /data are not grants (#1272).
 */
export function grantedKnowledgePaths(pluginConfig: AgentPluginConfig | null): string[] {
  return grantedDataPaths(pluginConfig);
}

/**
 * Whether the nightly sweep reindexes this agent.
 *
 * Only agents that SEARCH the index: retrieval is scoped by the searching
 * agent's grants, so the folders of agents with `knowledge_search` are exactly
 * the folders any search can reach. An agent that only reads files never looks
 * at the index, and embedding its folders every night would be work nobody
 * uses. Nothing else decides it — personal or shared makes no difference: an
 * agent whose answers come from the index needs the index current either way,
 * and indexing reveals nothing a search could not already reach.
 */
export function isScheduledIndexAgent(agent: ScheduledIndexCandidate): boolean {
  return (
    agent.deletedAt === null &&
    agent.allowedTools.includes("knowledge_search") &&
    grantedKnowledgePaths(agent.pluginConfig).length > 0
  );
}
