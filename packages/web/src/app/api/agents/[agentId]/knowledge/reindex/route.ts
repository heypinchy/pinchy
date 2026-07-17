import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { knowledgeReindexSchema } from "@/lib/schemas/knowledge-base";
import { db } from "@/db";
import { activeAgents, type AgentPluginConfig } from "@/db/schema";
import { enqueueIndexJob, getLatestIndexJobForAgent } from "@/lib/knowledge/index-jobs";
import { reindexAuditEntry } from "@/lib/knowledge/reindex-audit";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { getSetting } from "@/lib/settings";
import { PROVIDERS } from "@/lib/providers";
import { deferAuditLog } from "@/lib/audit-deferred";
import { safeProviderError, type EntityRef } from "@/lib/audit";

type RouteContext = { params: Promise<{ agentId: string }> };

/** The agent, or null if it does not exist / is deleted. */
async function findAgent(agentId: string) {
  const [agent] = await db.select().from(activeAgents).where(eq(activeAgents.id, agentId)).limit(1);
  return agent ?? null;
}

/**
 * The agent's granted knowledge-base folders, optionally narrowed to a
 * requested subset. A requested path outside the allowlist is dropped, so the
 * body can only ever narrow the granted set — never widen it to index an
 * arbitrary host directory.
 */
function resolveTargetPaths(agent: { pluginConfig: unknown }, requested?: string[]): string[] {
  const granted =
    (agent.pluginConfig as AgentPluginConfig | null)?.["pinchy-files"]?.allowed_paths ?? [];
  return requested ? requested.filter((p) => granted.includes(p)) : granted;
}

/**
 * POST /api/agents/[agentId]/knowledge/reindex — admin-only trigger to
 * (re)ingest an agent's granted knowledge-base folders into the corpus-wide
 * index.
 *
 * Enqueues; it does not index. A realistic corpus (~2k PDFs) is 1.5-7h of
 * CPU-only embedding, so the work belongs to the background worker
 * (src/server/kb-index-worker.ts) and this route hands back a job id to poll
 * via GET on the same path (#714).
 *
 * Access boundary: admin-only (`withAdmin`) — index management is an admin
 * action. The folders reindexed are resolved from the SAME source the search
 * route scopes retrieval by: the agent's admin-configured `pinchy-files`
 * `allowed_paths`.
 *
 * Both the resolved paths and the agent's name are snapshotted onto the job:
 * the worker must index what was authorized at the moment of the request, and
 * must be able to name the agent on its outcome row hours later.
 */
export const POST = withAdmin<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;
  const actorId = session.user.id!;

  const parsed = await parseRequestBody(knowledgeReindexSchema, request);
  if ("error" in parsed) return parsed.error;

  const agent = await findAgent(agentId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const agentRef: EntityRef = { id: agent.id, name: agent.name };
  const targetPaths = resolveTargetPaths(agent, parsed.data.paths);

  // Nothing granted (or nothing left after narrowing) — an honest no-op, not an
  // error and not a job: there is no work to watch. Still audited so the action
  // is on the record.
  if (targetPaths.length === 0) {
    deferAuditLog(
      reindexAuditEntry({
        actorType: "user",
        actorId,
        agent: agentRef,
        outcome: "success",
        pathCount: 0,
      })
    );
    return NextResponse.json({ jobId: null, status: "noop", pathCount: 0 });
  }

  // The embedding model is fixed (bge-m3) but still needs a reachable Ollama
  // base URL — the same admin-configured "Ollama (Local)" provider setting the
  // search route and the chat/vision path already resolve. Checked here as well
  // as in the worker: queueing a job that can only fail, and saying so hours
  // later, is worse than saying it now. The worker re-checks because the
  // setting can change while a job waits.
  const ollamaBaseUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);
  if (!ollamaBaseUrl) {
    deferAuditLog(
      reindexAuditEntry({
        actorType: "user",
        actorId,
        agent: agentRef,
        outcome: "failure",
        pathCount: targetPaths.length,
        reason: "ollama_not_configured",
      })
    );
    return NextResponse.json(
      { error: "Knowledge base embedding endpoint not configured" },
      { status: 503 }
    );
  }

  let enqueued;
  try {
    enqueued = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: actorId,
      paths: targetPaths,
    });
  } catch (err) {
    // safeProviderError scrubs emails + caps length; the underlying error could
    // echo a filesystem path, which this HMAC-signed audit row must not carry.
    deferAuditLog(
      reindexAuditEntry({
        actorType: "user",
        actorId,
        agent: agentRef,
        outcome: "failure",
        pathCount: targetPaths.length,
        reason: safeProviderError(err instanceof Error ? err.message : "enqueue_failed"),
      })
    );
    return NextResponse.json(
      { error: "Knowledge base reindex could not be queued" },
      { status: 500 }
    );
  }

  // One index run per org at a time (the index is corpus-wide and embedding is
  // CPU-bound). Answering 409 WITH the blocking job — rather than a bare
  // rejection — is what lets the admin watch the run that is actually
  // happening instead of clicking again into a queue that will never grow.
  //
  // That run may belong to a DIFFERENT agent, since the limit is per org while
  // status is only readable per agent. So the response names the blocking
  // agent as well: a jobId whose status endpoint the caller can't find is not
  // an answer, it's a riddle.
  if (enqueued.status === "busy") {
    const blocking: EntityRef = { id: enqueued.job.agentId, name: enqueued.job.agentName };
    deferAuditLog(
      reindexAuditEntry({
        actorType: "user",
        actorId,
        agent: agentRef,
        outcome: "failure",
        pathCount: targetPaths.length,
        jobId: enqueued.job.id,
        reason: "index_job_already_running",
      })
    );
    return NextResponse.json(
      {
        error: "A knowledge base reindex is already running",
        jobId: enqueued.job.id,
        status: enqueued.job.status,
        agent: blocking,
      },
      { status: 409 }
    );
  }

  deferAuditLog(
    reindexAuditEntry({
      actorType: "user",
      actorId,
      agent: agentRef,
      outcome: "success",
      pathCount: targetPaths.length,
      jobId: enqueued.job.id,
    })
  );

  // 202, not 200: the reindex has been accepted, not performed. The outcome —
  // and the counts — arrive via GET (and a `knowledge.reindex` audit row from
  // the worker).
  return NextResponse.json(
    { jobId: enqueued.job.id, status: enqueued.job.status, pathCount: targetPaths.length },
    { status: 202 }
  );
});

/**
 * GET /api/agents/[agentId]/knowledge/reindex — the agent's most recent index
 * run: in flight or last finished.
 *
 * A projection of the job's state, not the job row: the enqueue-time `paths`
 * snapshot is the run's input, which the admin already owns in the permissions
 * UI and which can disagree with the grants they are looking at now.
 *
 * Admin-only, like the reindex it reports on.
 */
// audit-exempt: read-only status projection, no state change.
export const GET = withAdmin<RouteContext>(async (_request, { params }) => {
  const { agentId } = await params;

  const agent = await findAgent(agentId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const job = await getLatestIndexJobForAgent(agentId);
  if (!job) return NextResponse.json({ job: null });

  return NextResponse.json({
    job: {
      id: job.id,
      status: job.status,
      /** Documents behind the run, and how many discovery found. `total` is null until discovery has walked every root. */
      processed: job.processed,
      total: job.total,
      /** The run's findings; null until it finishes. `unsearchable` and `failed` are the counters that say a document will never answer a question. */
      counts: job.counts,
      /** Scrubbed failure summary; null unless the run failed systemically. */
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    },
  });
});
