"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  CalendarClock,
  Circle,
  CircleCheck,
  CircleX,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { KnowledgeUnsearchableList } from "@/components/knowledge-unsearchable-list";
import { apiGet, apiPost, errorMessage } from "@/lib/api-client";
import {
  appendProgressSample,
  estimateRemainingMs,
  formatEta,
  type ProgressSample,
} from "@/lib/knowledge/index-eta";
import type { KbIndexJobTrigger } from "@/db/enums";
import type { NextIndexRun } from "@/lib/knowledge/index-schedule";
import type { IngestResult } from "@/lib/knowledge/types";
import type { KnowledgeReindexRequest } from "@/lib/schemas/knowledge-base";

type JobStatus = "pending" | "running" | "succeeded" | "failed";

/** The status projection returned by GET …/knowledge/reindex (dates as ISO strings over JSON). */
interface ReindexJob {
  id: string;
  status: JobStatus;
  /** Who started the run: an admin, the nightly reindex, or Pinchy after an update. Absent on a run this component just started itself. */
  trigger?: KbIndexJobTrigger;
  /** Folders the run left as they were: unreadable, or empty while the index still held their documents. */
  unavailableFolders?: number;
  processed: number;
  total: number | null;
  /** The same progress weighted by bytes of the corpus — the work-proportional measure the bar and the estimate are built on (#907). `totalBytes` is null until discovery has walked every root. */
  processedBytes: number;
  totalBytes: number | null;
  counts: IngestResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The nightly reindex as it applies to this agent (GET …/knowledge/reindex → `schedule`). */
interface ReindexSchedule {
  enabled: boolean;
  time: string;
  timezone: string;
  nextRun: NextIndexRun | null;
  /** Whether the nightly sweep covers this agent — only agents that search the index are. */
  included: boolean;
}

/** POST …/knowledge/reindex: 202 carries a jobId; the no-op path carries jobId=null. */
interface ReindexPostResponse {
  jobId: string | null;
  status: string;
  pathCount: number;
}

const ACTIVE_STATUSES: readonly JobStatus[] = ["pending", "running"];
const isActive = (job: ReindexJob | null): boolean =>
  job !== null && ACTIVE_STATUSES.includes(job.status);

export interface KnowledgeReindexSectionProps {
  agentId: string;
  /**
   * How many directories the agent is granted. With none, a reindex is a
   * server-side no-op, so the trigger is disabled and the reason is shown
   * instead of letting the admin click into an honest-but-confusing no-op.
   */
  allowedPathCount: number;
  /**
   * True while the directory picker holds changes that aren't saved. A reindex
   * reads the SAVED grants, so it would run over the old folders: the trigger
   * waits until the change is saved, and says so.
   */
  hasUnsavedPathChanges?: boolean;
  /** Poll cadence while a run is in flight. Injectable so tests need not wait seconds. */
  pollIntervalMs?: number;
}

/**
 * Admin control for the async knowledge-base reindex (#714): trigger a run and
 * watch it. The heavy lifting (queue, worker, audit) is server-side; this is the
 * surface that lets an admin start an index and see progress/outcome without
 * reading logs.
 *
 * Belongs under the "Allowed Directories" picker because a reindex operates on
 * exactly the folders granted there. The picker owns the "unsaved changes"
 * notice, which says what saving will change; this section only holds the
 * trigger back until then (#1305).
 *
 * Layout (#1305): a status line an admin can read at a glance — a badge that
 * says healthy / needs attention / failed / indexing, and one sentence — with
 * the trigger beside it; the run's detail below; the nightly schedule as a
 * footer, because it is about the future rather than the last run.
 */
export function KnowledgeReindexSection({
  agentId,
  allowedPathCount,
  hasUnsavedPathChanges = false,
  pollIntervalMs = 3000,
}: KnowledgeReindexSectionProps) {
  const [job, setJob] = useState<ReindexJob | null>(null);
  const [schedule, setSchedule] = useState<ReindexSchedule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Whether ANY status read has answered yet, and whether the last one failed
  // before any did. Without it the section said "Not indexed" while it was
  // still asking — about an index that might be perfectly fine.
  const [read, setRead] = useState<"pending" | "ok" | "failed">("pending");
  const url = `/api/agents/${agentId}/knowledge/reindex`;

  // Monotonic ticket per status read: a response only lands if it is still the
  // NEWEST read issued. Reads overlap (mount fetch, post-trigger fetch, poll
  // ticks), and a slow early response must not overwrite a later one — the
  // mount-time `job: null` arriving after a trigger would silently clear the
  // run the admin just started.
  const fetchSeq = useRef(0);

  const fetchStatus = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const res = await apiGet<{ job: ReindexJob | null; schedule?: ReindexSchedule | null }>(url);
      if (seq === fetchSeq.current) {
        setJob(res.job);
        if (res.schedule) setSchedule(res.schedule);
        setRead("ok");
      }
    } catch {
      // Only a section that has never had an answer says so; once one landed,
      // the last-known state stands (see below).
      if (seq === fetchSeq.current) setRead((prev) => (prev === "ok" ? prev : "failed"));
      // A failed status read is non-fatal: keep the last-known state and let the
      // next poll (or the user) retry. Deliberately no toast — a polling error
      // would spam one every interval.
    }
  }, [url]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Poll ONLY while a run is in flight; the effect tears the interval down the
  // moment the status leaves pending/running, so a finished run stops polling.
  const active = isActive(job);

  // The moment a run this section watched comes to an end. A small corpus can
  // finish between two polls, so the bar never gets to say "x of y" — without
  // this, a run ended with nothing but a new timestamp (#1305). A run that had
  // already ended when the page opened is not news, and gets no toast.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active && job) {
      if (job.status === "succeeded") {
        toast.success(
          job.counts ? `Reindex finished: ${summarizeRun(job.counts)}.` : "Reindex finished."
        );
      } else if (job.status === "failed") {
        toast.error(job.error ? `Reindex failed: ${job.error}` : "Reindex failed.");
      }
    }
    wasActive.current = active;
  }, [active, job]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void fetchStatus(), pollIntervalMs);
    return () => clearInterval(id);
  }, [active, fetchStatus, pollIntervalMs]);

  // A once-per-second clock, live ONLY while a run is active, so the elapsed
  // readout ticks smoothly instead of jumping on each 3s poll. Reading the
  // wall clock here (in an effect, not during render) keeps the component pure;
  // `now` is null while idle so nothing renders an age for a finished/absent run.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  // Byte readings over time, the input the time-to-completion estimate is
  // computed from (#907). Sampled here rather than derived from `startedAt`,
  // because the run's own average keeps paying for the model load and the
  // discovery walk forever and never notices a change in throughput. One
  // sample per status read; index-eta.ts owns the window and the arithmetic.
  const [samples, setSamples] = useState<ProgressSample[]>([]);
  useEffect(() => {
    if (!active || job === null || job.totalBytes === null) {
      // Identity-preserving so an already-empty series does not re-render.
      setSamples((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    setSamples((prev) =>
      appendProgressSample(prev, { at: Date.now(), processedBytes: job.processedBytes })
    );
  }, [active, job]);

  const handleReindex = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await apiPost<ReindexPostResponse, KnowledgeReindexRequest>(url, {});
      if (res.jobId === null) {
        // Server-side no-op (nothing granted, or nothing left after narrowing):
        // honest info, not an error — there is simply no work to watch.
        toast.info("Nothing to index — grant at least one directory first.");
        return;
      }
      // Optimistically show the queued run so the trigger locks immediately; the
      // poll fills in real discovery/progress on its next tick.
      setJob({
        id: res.jobId,
        status: "pending",
        processed: 0,
        total: null,
        processedBytes: 0,
        totalBytes: null,
        counts: null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      });
      void fetchStatus();
    } catch (err) {
      // 409 (already running), 503 (embedder missing) and 500 all arrive here as
      // an ApiError whose message is the route's human-readable `error`.
      toast.error(errorMessage(err, "Reindex could not be started."));
    } finally {
      setSubmitting(false);
    }
  }, [url, fetchStatus]);

  const triggerDisabled = allowedPathCount === 0 || active || submitting || hasUnsavedPathChanges;

  const status = describeStatus(allowedPathCount, job, active, read);

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Index</h4>
      <div className="rounded-lg border">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          {/* Badge + one sentence, and nothing that changes per poll: a live
              region that re-reads "Indexing 41 of 300" every three seconds is
              noise. The moving numbers live below, outside it. */}
          <div
            role="status"
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          >
            <IndexStatusBadge tone={status.tone} label={status.label} />
            <span>{status.headline}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleReindex}
            disabled={triggerDisabled}
            aria-busy={active || submitting}
            className="w-full shrink-0 sm:w-auto"
          >
            <RefreshCw
              className={active ? "animate-spin motion-reduce:animate-none" : undefined}
              aria-hidden="true"
            />
            {active ? "Reindexing…" : "Reindex now"}
          </Button>
        </div>

        {(allowedPathCount > 0 || hasUnsavedPathChanges) && (
          <div className="space-y-3 px-4 pb-4 empty:hidden">
            {hasUnsavedPathChanges && !active && (
              <p className="text-sm text-muted-foreground">
                Save your directory changes first. Reindex now works on the saved directories.
              </p>
            )}
            {allowedPathCount === 0 ? null : active && job ? (
              <RunningState job={job} now={now} samples={samples} />
            ) : job?.status === "succeeded" ? (
              <SucceededState job={job} />
            ) : job?.status === "failed" ? (
              <FailedState job={job} />
            ) : null}

            {/* Which documents the counts above mean by "unsearchable" (#935).
                Hidden while a run is in flight — the list is about to change —
                and hidden without a grant, where there is nothing to report on.
                Documents that exist are listed in every other state, since the
                index is corpus-wide and another agent's run can have filled
                this scope.

                A zero, though, is only announced after a SUCCEEDED run. Before
                any run, "every document came back with searchable text" is
                trivially true of an empty index and would sit under "Not
                indexed"; after a FAILED one it would sit under "Last reindex
                failed" and read as an all-clear about a run that stopped early.
                Both are reassurances the evidence doesn't support. */}
            {allowedPathCount > 0 && !active && (
              <KnowledgeUnsearchableList
                agentId={agentId}
                announceNone={job?.status === "succeeded"}
                reloadKey={`${allowedPathCount}:${job?.id ?? "none"}:${job?.status ?? "none"}`}
              />
            )}
          </div>
        )}

        {allowedPathCount > 0 && schedule && (
          <div className="flex items-start gap-2 border-t bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <ScheduleNote schedule={schedule} />
          </div>
        )}
      </div>
    </div>
  );
}

type StatusTone = "neutral" | "busy" | "good" | "attention" | "bad";

interface IndexStatus {
  tone: StatusTone;
  /** One or two words for the badge. */
  label: string;
  /** The sentence beside it. Stable while a run is in flight — see the live region. */
  headline: string;
}

/**
 * The section's answer to "is this index healthy?", before any number is read.
 *
 * "Needs attention" is a run that finished but left something an agent can't
 * answer from: a document that failed or holds no searchable text, or a
 * folder it couldn't read. Those are exactly the counters the summary below
 * colours, so the badge and the detail never disagree.
 */
function describeStatus(
  allowedPathCount: number,
  job: ReindexJob | null,
  active: boolean,
  read: "pending" | "ok" | "failed"
): IndexStatus {
  if (allowedPathCount === 0) {
    return {
      tone: "neutral",
      label: "No directories",
      headline: "Grant at least one directory above and save to build this agent's index.",
    };
  }
  // A run this component just started is known without a read; anything else
  // isn't until the first read answers.
  if (!active && read === "pending") {
    return { tone: "neutral", label: "Checking", headline: "Checking the index…" };
  }
  if (!active && read === "failed") {
    return {
      tone: "neutral",
      label: "Unknown",
      headline: "Couldn't load the index status. Reload the page to try again.",
    };
  }
  if (active) {
    return {
      tone: "busy",
      label: "Indexing",
      headline: "Reading the directories. The run continues if you leave this page.",
    };
  }
  if (job?.status === "failed") {
    return {
      tone: "bad",
      label: "Failed",
      headline: `Last reindex failed ${formatWhen(job.finishedAt)}.`,
    };
  }
  if (job?.status === "succeeded") {
    // Anything an admin did not start, Pinchy did: the nightly run, or the one
    // it starts itself after an update changed how documents are converted.
    const how = job.trigger !== undefined && job.trigger !== "manual" ? "automatically " : "";
    const summary = job.counts ? ` — ${summarizeRun(job.counts)}` : "";
    const headline = `Last indexed ${how}${formatWhen(job.finishedAt)}${summary}.`;
    const needsAttention =
      (job.counts?.failed ?? 0) > 0 ||
      (job.counts?.unsearchable ?? 0) > 0 ||
      (job.unavailableFolders ?? 0) > 0;
    // A green badge says the last run went well. It can't say that folders
    // granted SINCE that run are in it: the route doesn't hand out the run's
    // paths. The nightly run (or Reindex now) closes that gap.
    return needsAttention
      ? { tone: "attention", label: "Needs attention", headline }
      : { tone: "good", label: "Indexed", headline };
  }
  // About THIS agent's runs, not about what it can find: the index is shared,
  // so another agent's run may already have made these folders searchable.
  return {
    tone: "neutral",
    label: "No runs yet",
    headline: "This agent hasn't been indexed yet. Reindex now builds its index.",
  };
}

/** "13 documents checked, 2 new or changed" — a run in words, for the status line and the toast. */
function summarizeRun(counts: IngestResult): string {
  const checked = counts.indexed + counts.skipped + counts.unsearchable + counts.failed;
  const changes = [
    counts.indexed > 0 ? `${counts.indexed} new or changed` : null,
    counts.removed > 0 ? `${counts.removed} removed` : null,
  ].filter((part): part is string => part !== null);
  const what = changes.length > 0 ? changes.join(", ") : "nothing new";
  return `${checked} ${checked === 1 ? "document" : "documents"} checked, ${what}`;
}

// Same palette as StatusBadge (status-badge.tsx), so "healthy" looks the same
// here as on the Users and Groups pages. Each pair clears 4.5:1.
const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  busy: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  good: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  attention: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  bad: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

const TONE_ICONS: Record<StatusTone, typeof Circle> = {
  neutral: Circle,
  busy: LoaderCircle,
  good: CircleCheck,
  attention: TriangleAlert,
  bad: CircleX,
};

function IndexStatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  const Icon = TONE_ICONS[tone];
  return (
    <Badge variant="outline" className={`border-transparent ${TONE_CLASSES[tone]}`}>
      <Icon
        className={tone === "busy" ? "animate-spin motion-reduce:animate-none" : undefined}
        aria-hidden="true"
      />
      {label}
    </Badge>
  );
}

function RunningState({
  job,
  now,
  samples,
}: {
  job: ReindexJob;
  now: number | null;
  samples: readonly ProgressSample[];
}) {
  // How long the worker has been on this run — measured, and shown beside the
  // projection below rather than replaced by it: an operator needs to tell
  // "this is how long it HAS taken" from "this is how long it MIGHT take".
  // Empty until the worker has started the job AND the clock ticked.
  const elapsedSuffix =
    job.startedAt && now !== null
      ? ` · running ${formatElapsed(new Date(job.startedAt).getTime(), now)}`
      : "";

  // Null whenever the readings cannot support an answer — too little evidence,
  // no measurable movement, no known total. Absent is a state this readout is
  // expected to spend real time in: an ETA that lies is worse than no ETA, and
  // the doc-count projection this replaces lied by construction (see
  // lib/knowledge/index-eta.ts).
  const remainingMs = estimateRemainingMs(samples, job.totalBytes);
  const etaSuffix = remainingMs === null ? "" : ` · ${formatEta(remainingMs)}`;

  // `total` is null until discovery has walked every root — an indeterminate
  // phase we name rather than fake a percentage for.
  if (job.total === null) {
    return (
      <div className="space-y-2">
        <Progress value={0} aria-label="Indexing progress" />
        <p className="text-sm text-muted-foreground">
          Discovering documents…{elapsedSuffix}
          {etaSuffix}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Progress value={progressPct(job)} aria-label="Indexing progress" />
      <p className="text-sm text-muted-foreground">
        Indexing {job.processed} of {job.total} documents…{elapsedSuffix}
        {etaSuffix}
      </p>
    </div>
  );
}

/**
 * How full the bar is, in percent.
 *
 * Bytes when discovery has weighed the corpus, documents otherwise. Documents
 * are not equal units of work — in the 2026-07 dry-run one compilation PDF was
 * 38% of all chunks beside hundreds of one-chunk product sheets — so a
 * doc-count bar sits at 98% while an hour of work remains. Bytes track text
 * volume closely enough that the outsized document is anticipated instead of
 * discovered at the end, and the worker credits a long document's bytes as its
 * chunks are embedded, so the bar keeps moving inside it.
 *
 * Clamped: either counter can momentarily overshoot a total snapshotted a poll
 * earlier, and a >100 value flips the Radix progressbar into its indeterminate
 * state.
 */
function progressPct(job: ReindexJob): number {
  const [done, all] =
    job.totalBytes !== null && job.totalBytes > 0
      ? [job.processedBytes, job.totalBytes]
      : [job.processed, job.total ?? 0];
  return all > 0 ? Math.min(100, Math.round((done / all) * 100)) : 0;
}

/**
 * Humanizes an elapsed duration (`nowMs − startedAtMs`) as a compact
 * "42 sec" / "12 min" / "2 h 5 min" string. Clock skew (now before start)
 * clamps to "0 sec" rather than showing a negative age, as does an
 * unparseable timestamp — NaN survives Math.max/floor and would otherwise
 * render as "NaN h NaN min" (same guard formatWhen applies to its own date).
 * Seconds are floored once past a minute, and the minutes component is
 * dropped on an exact hour.
 */
export function formatElapsed(startedAtMs: number, nowMs: number): string {
  const elapsedMs = nowMs - startedAtMs;
  if (Number.isNaN(elapsedMs)) return "0 sec";
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec} sec`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * Whether the nightly reindex keeps this agent current. The line that answers
 * "do I still have to press the button?" — and, when the answer is yes, says
 * why and where to change it.
 */
function ScheduleNote({ schedule }: { schedule: ReindexSchedule }) {
  let text: string;
  if (!schedule.enabled) {
    text =
      "The nightly reindex is off, so new documents show up only when you reindex. You can turn it on in Settings → Organization.";
  } else if (!schedule.included) {
    text =
      "The nightly reindex skips this agent because it doesn't use knowledge search. Reindex it here when its documents change.";
  } else {
    text = `New and changed documents are picked up every night at ${nightlyTimeText(schedule)}.${nextRunText(schedule.nextRun)}`;
  }
  return <p>{text}</p>;
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** A valid instant from the route's `nextRun.at`, or null. */
function nextRunInstant(nextRun: NextIndexRun | null): Date | null {
  if (!nextRun?.at) return null;
  const at = new Date(nextRun.at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The nightly time in the viewer's own clock, like every other time on the
 * page ("Last indexed" included).
 *
 * The setting is a wall-clock time in the organization's time zone. For a
 * viewer in that zone it is shown as set — read off the next run instead, it
 * would say 03:00 on the eve of the spring-forward night, when 02:00 does not
 * happen. For a viewer elsewhere it is converted through the next run, with
 * the setting beside it: Settings → Organization shows that one, and the two
 * must be recognisably the same schedule.
 */
function nightlyTimeText(schedule: ReindexSchedule): string {
  const at = nextRunInstant(schedule.nextRun);
  if (!at) return `${schedule.time} (${schedule.timezone})`;
  let orgClock: string;
  try {
    orgClock = at.toLocaleTimeString(undefined, { ...CLOCK, timeZone: schedule.timezone });
  } catch {
    // A zone this browser doesn't know: say it the way it is stored.
    return `${schedule.time} (${schedule.timezone})`;
  }
  const viewerClock = at.toLocaleTimeString(undefined, CLOCK);
  if (orgClock === viewerClock) {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    return new Date(Date.UTC(2000, 0, 1, hours, minutes)).toLocaleTimeString(undefined, {
      ...CLOCK,
      timeZone: "UTC",
    });
  }
  return `${viewerClock} your time (${schedule.time} ${schedule.timezone})`;
}

/** Midnight-to-midnight days between two instants, on the viewer's calendar. */
function localDaysBetween(from: Date, to: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/**
 * "Next run: tomorrow at 04:00." — day and time on the viewer's calendar and
 * clock. The route's own `day` is the organization's, which is not the
 * viewer's: 02:00 UTC is still today for someone in New York the evening
 * before.
 */
function nextRunText(nextRun: NextIndexRun | null): string {
  if (!nextRun) return "";
  const at = nextRunInstant(nextRun);
  if (!at) return ` Next run: ${nextRun.day} at ${nextRun.time}.`;
  // The next run is at most a day ahead, so this is today or tomorrow —
  // except on a 25-hour night, where it can be the day after.
  const days = localDaysBetween(new Date(), at);
  const day =
    days <= 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : at.toLocaleDateString(undefined, { weekday: "long" });
  return ` Next run: ${day} at ${at.toLocaleTimeString(undefined, CLOCK)}.`;
}

/**
 * A success with a hole in it: some folders could not be read (a share that
 * failed to mount, most likely) and their documents were kept as they were.
 * Without this line the run reads as a plain "Last indexed …" for as long as
 * the share stays down.
 */
function UnavailableFoldersNote({ count }: { count: number }) {
  const text =
    count === 1
      ? "One folder couldn't be read, so its documents were left as they were. If it lives on a network share, check that it is mounted."
      : `${count} folders couldn't be read, so their documents were left as they were. If they live on a network share, check that it is mounted.`;
  return (
    <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

function SucceededState({ job }: { job: ReindexJob }) {
  if (!job.counts && !(job.unavailableFolders ?? 0)) return null;
  return (
    <>
      {job.counts && <CountsSummary counts={job.counts} />}
      {(job.unavailableFolders ?? 0) > 0 && (
        <UnavailableFoldersNote count={job.unavailableFolders!} />
      )}
    </>
  );
}

function FailedState({ job }: { job: ReindexJob }) {
  // The status line already says it failed and when; this says why.
  return (
    <>
      {job.error && (
        <Alert variant="destructive">
          <CircleX aria-hidden="true" />
          <AlertDescription>{job.error}</AlertDescription>
        </Alert>
      )}
      {job.counts && <CountsSummary counts={job.counts} />}
    </>
  );
}

/**
 * The per-run findings. `unsearchable` and `failed` are the counters that mean
 * "this document will never answer a question", so they are always shown — even
 * at zero — rather than folded into a single "done" number.
 */
function CountsSummary({ counts }: { counts: IngestResult }) {
  const archived = counts.archived ?? 0;
  return (
    <div className="space-y-1">
      <ul aria-label="Last run" className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
        <li className="text-muted-foreground">{counts.indexed} new or changed</li>
        {/* The ingest counter is `skipped`, but every path into it is a file
            whose content hash matched: nothing to do, not something left out. */}
        <li className="text-muted-foreground">{counts.skipped} unchanged</li>
        {counts.removed > 0 && <li className="text-muted-foreground">{counts.removed} removed</li>}
        {/* `unsearchable` in the API; "unsearchable" on screen was not
            understood. The list below names them when there are any. */}
        <li
          className={
            counts.unsearchable > 0
              ? "font-medium text-amber-700 dark:text-amber-400"
              : "text-muted-foreground"
          }
        >
          {counts.unsearchable} without readable text
        </li>
        <li
          className={counts.failed > 0 ? "font-medium text-destructive" : "text-muted-foreground"}
        >
          {counts.failed} failed
        </li>
        {/* Orthogonal to the others: an archived document is also new or
            unchanged. Shown only when there are some. */}
        {archived > 0 && <li className="text-muted-foreground">{archived} in archive folders</li>}
      </ul>
      {archived > 0 && (
        <p className="text-xs text-muted-foreground">
          Documents in archive folders (like OLD or Archiv) are indexed, but the agent searches them
          only when asked about the archive. Everyday answers come from current documents.
        </p>
      )}
    </div>
  );
}

/**
 * When a run finished, as the rest of a sentence: "today at 18:15",
 * "yesterday at 23:50", "on 28 Oct 2026 at 09:05". Local time, to the minute —
 * an admin checking the index wants "an hour ago", not "18:15:10" to work it
 * out from (#1305). `now` is injectable for tests.
 */
export function formatWhen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "just now";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "just now";
  const time = at.toLocaleTimeString(undefined, CLOCK);
  const days = localDaysBetween(at, now);
  // <= 0: a server clock a little ahead of this one is still "today".
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `on ${at.toLocaleDateString(undefined, { dateStyle: "medium" })} at ${time}`;
}
