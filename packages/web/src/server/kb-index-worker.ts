/**
 * The knowledge-base index worker (#714).
 *
 * Claims a kb_index_jobs row, runs the ingest against the paths the job
 * snapshotted at enqueue, publishes progress as it goes, and records the
 * outcome — on the job row and in the audit trail.
 *
 * Lives in the web process on a setInterval, like every other background job
 * here (upload-gc, chat-error-gc, audit-verify-job): one container, one worker,
 * stopped through buildShutdownSteps so SIGTERM doesn't hang. That single-
 * container assumption is also what makes requeueOrphanedIndexJobs() safe at
 * boot — see its doc comment.
 *
 * A run can take hours (a ~2k-PDF corpus is 1.5-7h of CPU-only embedding), so
 * the interval is a poll for NEW work, not a run cadence: the re-entrancy guard
 * keeps overlapping ticks from starting a second run.
 */
import { appendAuditLog } from "@/lib/audit";
import { safeProviderError } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { embedTexts } from "@/lib/knowledge/embeddings";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/lib/knowledge/constants";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import { ingestPaths, type IngestDeps } from "@/lib/knowledge/ingest";
import {
  claimNextIndexJob,
  finishIndexJob,
  recordIndexJobProgress,
  requeueOrphanedIndexJobs,
  type KbIndexJob,
} from "@/lib/knowledge/index-jobs";
import { KB_INDEX_WORKER_ACTOR, reindexAuditEntry } from "@/lib/knowledge/reindex-audit";
import { zeroIngestResult, type IngestResult } from "@/lib/knowledge/types";
import { PROVIDERS } from "@/lib/providers";
import { getSetting } from "@/lib/settings";

/** Resolves the production embedder + extractor, or null if the KB's embedding endpoint is not configured. */
async function resolveIngestDeps(): Promise<IngestDeps | null> {
  const ollamaBaseUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);
  if (!ollamaBaseUrl) return null;

  return {
    embed: (texts) =>
      embedTexts(texts, {
        baseUrl: ollamaBaseUrl,
        model: EMBEDDING_MODEL,
        expectedDim: EMBEDDING_DIMENSIONS,
      }),
    extractPdf: extractPdfPages,
  };
}

export interface RunIndexJobOptions {
  /** Test seam: injects a deterministic embedder/extractor. Production resolves them from the admin-configured Ollama endpoint. */
  deps?: IngestDeps;
}

/**
 * Runs the next queued job to completion, or returns null if there is none.
 *
 * Exported for tests and for the boot kick; the interval calls it through the
 * re-entrancy guard below.
 */
export async function runNextIndexJob(opts: RunIndexJobOptions = {}): Promise<KbIndexJob | null> {
  const job = await claimNextIndexJob();
  if (!job) return null;

  const agent = { id: job.agentId, name: job.agentName };
  // Updated from every progress report, NOT from ingestPaths' return value: a
  // systemic throw skips the return, and a run that died on file 1501 of 2000
  // still indexed 1500 documents. Reading the tally off the last report is the
  // only way that survives the throw.
  let counts: IngestResult = zeroIngestResult();

  try {
    // Resolved per run, not per process: an admin can configure Ollama after a
    // job is already queued, and the route's 503 only covers the moment of the
    // request.
    const deps = opts.deps ?? (await resolveIngestDeps());
    if (!deps) throw new Error("ollama_not_configured");

    counts = await ingestPaths(job.orgId, job.paths, deps, {
      onProgress: (progress) => {
        counts = progress.counts;
        return recordIndexJobProgress(job.id, progress);
      },
    });
  } catch (err) {
    // Ingest already absorbs a single unreadable file (counting it `failed`),
    // so reaching here means something systemic — the embedding endpoint or the
    // database — took the run down. Finishing the job (rather than leaving it
    // `running`) is what frees the org's active-job slot: without it, one
    // Ollama blip would wedge the queue until the next restart.
    //
    // The one case this cannot rescue is the database itself being the outage:
    // then finishIndexJob's own write fails too, the row stays `running`, and
    // the slot is held until the next boot requeues it. Recovering from that
    // without a restart would need a liveness signal (heartbeat + staleness
    // sweep) that the single-container design does not otherwise need — and a
    // database outage is already an operator's problem, not a queue's.
    const reason = safeProviderError(err instanceof Error ? err.message : "reindex_failed");
    await finishIndexJob(job.id, { outcome: "failed", counts, error: reason });
    await auditOutcome({ job, agent, outcome: "failure", counts, reason });
    return { ...job, status: "failed", counts, error: reason };
  }

  // `unsearchable` and `failed` files do not make this a failed run: the
  // reindex did its job, and those counts are findings about the corpus.
  // Burying them would be the failure.
  await finishIndexJob(job.id, { outcome: "succeeded", counts });
  await auditOutcome({ job, agent, outcome: "success", counts });
  return { ...job, status: "succeeded", counts };
}

/**
 * Writes the run's audit row.
 *
 * No request context here, so this follows the AGENTS.md non-request pattern:
 * await the append, and hand a failure to recordAuditFailure rather than
 * letting a broken audit sink take down a reindex that actually happened.
 */
async function auditOutcome(args: {
  job: KbIndexJob;
  agent: { id: string; name: string };
  outcome: "success" | "failure";
  counts: IngestResult;
  reason?: string;
}): Promise<void> {
  const entry = reindexAuditEntry({
    actorType: "system",
    actorId: KB_INDEX_WORKER_ACTOR,
    agent: args.agent,
    outcome: args.outcome,
    pathCount: args.job.paths.length,
    jobId: args.job.id,
    counts: args.counts,
    reason: args.reason,
  });
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }
}

/**
 * How often to look for new work. Short because it is a poll for a QUEUED job,
 * not a run cadence — a claimed run holds the guard below for as long as it
 * takes, however many ticks pass underneath it.
 */
const POLL_INTERVAL_MS = 10_000;

let _pollInterval: ReturnType<typeof setInterval> | null = null;
// Re-entrancy guard: a multi-hour run must not be started a second time by an
// overlapping tick. The DB claim would refuse the double-run anyway; this keeps
// us from hammering it every 10s for hours to find that out.
let _runInFlight = false;
// Whether this process has already cleaned up after its predecessor. See the
// requeue in runKbIndexWorkerTick for why doing it exactly once is not an
// optimization but a correctness condition.
let _orphansRequeued = false;

/**
 * One turn of the worker: adopt any jobs the previous process left behind, then
 * drain the queue.
 *
 * Exported for tests. The interval calls it; the re-entrancy guard means a tick
 * that lands during a multi-hour run returns immediately.
 */
export async function runKbIndexWorkerTick(opts: RunIndexJobOptions = {}): Promise<void> {
  if (_runInFlight) return;
  _runInFlight = true;
  try {
    // Requeueing is only sound as a BOOT act: a `running` job is safe to reset
    // precisely because this process is the only worker and has not started
    // one yet, so whatever holds it is gone. Once we begin claiming, that
    // premise dies — the next `running` job we would find is OUR OWN, and
    // resetting it flips a live run to `pending`, blanks its total, and makes
    // every status read lie for the hours it keeps running. Hence: strictly
    // before the first claim, and exactly once.
    if (!_orphansRequeued) {
      _orphansRequeued = true;
      const requeued = await requeueOrphanedIndexJobs();
      if (requeued > 0) {
        console.log(`[kb-index-worker] requeued ${requeued} job(s) orphaned by a restart`);
      }
    }

    // Drains the queue rather than running one job per tick. Today that loop
    // body runs at most once: Pinchy is single-tenant (DEFAULT_ORG_ID) and the
    // active-job index is per org, so there is never a second job to find. It
    // is a `while` because "keep going while there is work" is the rule the
    // worker should follow — an `if` would quietly become wrong the day a
    // second org exists, and costs exactly as much to write.
    while (await runNextIndexJob(opts)) {
      /* keep going while there is work */
    }
  } catch (err) {
    console.error("[kb-index-worker] job run failed:", err);
  } finally {
    _runInFlight = false;
  }
}

/**
 * Starts polling for queued index jobs.
 *
 * No post-boot kick, unlike the hourly sweeps (upload-gc, chat-error-gc): the
 * poll is already 10s, so the first tick IS the kick. Arming a second, earlier
 * path to the same work is what let an orphan-requeue race a claim the interval
 * had already made.
 */
export function startKbIndexWorker(): void {
  _pollInterval = setInterval(() => {
    void runKbIndexWorkerTick();
  }, POLL_INTERVAL_MS);
}

export function stopKbIndexWorker(): void {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

// Test-only helper (mirrors upload-gc / chat-error-gc / audit-verify-job).
export function _isKbIndexWorkerRunning(): boolean {
  return _pollInterval !== null;
}

/** Test-only: returns the module to its just-booted state, so a test can exercise the once-per-process orphan requeue. */
export function _resetKbIndexWorkerForTest(): void {
  _orphansRequeued = false;
  _runInFlight = false;
}
