"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { KnowledgeUnsearchableList } from "@/components/knowledge-unsearchable-list";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import {
  appendProgressSample,
  estimateRemainingMs,
  formatEta,
  type ProgressSample,
} from "@/lib/knowledge/index-eta";
import type { IngestResult } from "@/lib/knowledge/types";
import type { KnowledgeReindexRequest } from "@/lib/schemas/knowledge-base";

type JobStatus = "pending" | "running" | "succeeded" | "failed";

/** The status projection returned by GET …/knowledge/reindex (dates as ISO strings over JSON). */
interface ReindexJob {
  id: string;
  status: JobStatus;
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
   * True while the directory picker holds selections that differ from the
   * saved grants. A reindex only ever sees the SAVED grants, so the section
   * says so instead of letting the admin believe unsaved checkmarks count.
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
 * exactly the folders granted there.
 */
export function KnowledgeReindexSection({
  agentId,
  allowedPathCount,
  hasUnsavedPathChanges = false,
  pollIntervalMs = 3000,
}: KnowledgeReindexSectionProps) {
  const [job, setJob] = useState<ReindexJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
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
      const res = await apiGet<{ job: ReindexJob | null }>(url);
      if (seq === fetchSeq.current) setJob(res.job);
    } catch {
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
      toast.error(err instanceof ApiError ? err.message : "Reindex could not be started.");
    } finally {
      setSubmitting(false);
    }
  }, [url, fetchStatus]);

  const triggerDisabled = allowedPathCount === 0 || active || submitting;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h4 className="text-sm font-medium">Index</h4>
        <Button size="sm" variant="outline" onClick={handleReindex} disabled={triggerDisabled}>
          {active ? "Reindexing…" : "Reindex now"}
        </Button>
      </div>

      {hasUnsavedPathChanges && (
        <p className="text-sm text-muted-foreground">
          You have unsaved directory changes — a reindex uses the saved grants. Save to include
          them.
        </p>
      )}

      {allowedPathCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          Grant at least one directory to enable indexing.
        </p>
      ) : active && job ? (
        <RunningState job={job} now={now} samples={samples} />
      ) : job?.status === "succeeded" ? (
        <SucceededState job={job} />
      ) : job?.status === "failed" ? (
        <FailedState job={job} />
      ) : (
        <p className="text-sm text-muted-foreground">Not yet indexed.</p>
      )}

      {/* Which documents the counts above mean by "unsearchable" (#935). Hidden
          while a run is in flight — the list is about to change — and hidden
          without a grant, where there is nothing to report on. Documents that
          exist are listed in every other state, since the index is corpus-wide
          and another agent's run can have filled this scope.

          A zero, though, is only announced after a SUCCEEDED run. Before any
          run, "every document came back with searchable text" is trivially true
          of an empty index and would sit under "Not yet indexed"; after a
          FAILED one it would sit under "Last reindex failed" and read as an
          all-clear about a run that stopped early. Both are reassurances the
          evidence doesn't support. */}
      {allowedPathCount > 0 && !active && (
        <KnowledgeUnsearchableList
          agentId={agentId}
          announceNone={job?.status === "succeeded"}
          reloadKey={`${allowedPathCount}:${job?.id ?? "none"}:${job?.status ?? "none"}`}
        />
      )}
    </div>
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
        <Progress value={0} />
        <p className="text-sm text-muted-foreground">
          Discovering documents…{elapsedSuffix}
          {etaSuffix}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Progress value={progressPct(job)} />
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

function SucceededState({ job }: { job: ReindexJob }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Last indexed {formatWhen(job.finishedAt)}.</p>
      {job.counts && <CountsSummary counts={job.counts} />}
    </div>
  );
}

function FailedState({ job }: { job: ReindexJob }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Last reindex failed</AlertTitle>
      <AlertDescription className="space-y-2">
        {job.error && <span>{job.error}</span>}
        {job.counts && <CountsSummary counts={job.counts} />}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The per-run findings. `unsearchable` and `failed` are the counters that mean
 * "this document will never answer a question", so they are always shown — even
 * at zero — rather than folded into a single "done" number.
 */
function CountsSummary({ counts }: { counts: IngestResult }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">{counts.indexed} indexed</span>
      <span className="text-muted-foreground">{counts.skipped} skipped</span>
      {counts.removed > 0 && (
        <span className="text-muted-foreground">{counts.removed} removed</span>
      )}
      <span
        className={
          counts.unsearchable > 0 ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"
        }
      >
        {counts.unsearchable} unsearchable
      </span>
      <span className={counts.failed > 0 ? "text-destructive" : "text-muted-foreground"}>
        {counts.failed} failed
      </span>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "just now";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "just now" : d.toLocaleString();
}
