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

/** The next slot ahead of `clock`, or null while the schedule is off. */
export function nextIndexRun(clock: LocalClock, schedule: IndexSchedule): NextIndexRun | null {
  if (!schedule.enabled) return null;
  const today = clock.minutes < minutesOf(schedule.time);
  return {
    date: today ? clock.date : shiftDate(clock.date, 1),
    time: schedule.time,
    day: today ? "today" : "tomorrow",
  };
}

/** The fields of an agent row that decide whether the nightly sweep reindexes it. */
export interface ScheduledIndexCandidate {
  deletedAt: Date | null;
  allowedTools: string[];
  pluginConfig: AgentPluginConfig | null;
}

/** The folders an agent is granted — the same source the reindex route and the search route scope by. */
export function grantedKnowledgePaths(pluginConfig: AgentPluginConfig | null): string[] {
  return pluginConfig?.["pinchy-files"]?.allowed_paths ?? [];
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
