"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import type { IngestResult } from "@/lib/knowledge/types";
import type { KnowledgeReindexRequest } from "@/lib/schemas/knowledge-base";

type JobStatus = "pending" | "running" | "succeeded" | "failed";

/** The status projection returned by GET …/knowledge/reindex (dates as ISO strings over JSON). */
interface ReindexJob {
  id: string;
  status: JobStatus;
  processed: number;
  total: number | null;
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
  pollIntervalMs = 3000,
}: KnowledgeReindexSectionProps) {
  const [job, setJob] = useState<ReindexJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const url = `/api/agents/${agentId}/knowledge/reindex`;

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiGet<{ job: ReindexJob | null }>(url);
      setJob(res.job);
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

      {allowedPathCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          Grant at least one directory above to enable indexing.
        </p>
      ) : active ? (
        <RunningState job={job!} />
      ) : job?.status === "succeeded" ? (
        <SucceededState job={job} />
      ) : job?.status === "failed" ? (
        <FailedState job={job} />
      ) : (
        <p className="text-sm text-muted-foreground">Not yet indexed.</p>
      )}
    </div>
  );
}

function RunningState({ job }: { job: ReindexJob }) {
  // `total` is null until discovery has walked every root — an indeterminate
  // phase we name rather than fake a percentage for.
  if (job.total === null) {
    return (
      <div className="space-y-2">
        <Progress value={0} />
        <p className="text-sm text-muted-foreground">Discovering documents…</p>
      </div>
    );
  }
  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  return (
    <div className="space-y-2">
      <Progress value={pct} />
      <p className="text-sm text-muted-foreground">
        Indexing {job.processed} of {job.total} documents…
      </p>
    </div>
  );
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
