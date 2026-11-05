/**
 * An agent's first index: the run a folder nothing has indexed yet needs
 * before the agent can find anything in it (#1280).
 *
 * Granting a folder used to index nothing. A new Knowledge Base agent answered
 * "nothing found" until an admin found **Reindex now** or the nightly run got
 * to it — and an admin who creates the agent and tries it straight away
 * concludes it is broken. So the routes that grant a folder (creating the
 * agent, saving its permissions) queue that run themselves, and the index
 * worker looks for the ones that could not be queued then.
 *
 * Like the nightly run and the reconversion after an update, this only
 * QUEUES: an ordinary `kb_index_jobs` row (trigger `initial`) that the worker
 * runs like any other, behind the same one-run-at-a-time rule. When the slot
 * is taken the answer is "busy", nothing is recorded, and the worker queues
 * the run once the slot frees — the folder still being unindexed is the only
 * record that is needed, and it cannot get lost in a restart.
 *
 * "Indexed" is read from the runs, not from the documents: a folder with no
 * searchable file in it is as indexed as one with a thousand, and asking the
 * documents would run it again every time the worker looks.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { sep } from "node:path";

import { db } from "@/db";
import { agents, kbDocuments, kbIndexJobs } from "@/db/schema";
import { safeProviderError, type AuditLogEntry, type EntityRef } from "@/lib/audit";

import { DEFAULT_ORG_ID } from "./constants";
import { enqueueIndexJob, findActiveIndexJob } from "./index-jobs";
import { grantedKnowledgePaths, isScheduledIndexAgent } from "./index-schedule";
import { kbEmbedderAvailable } from "./kb-embedder";
import type { FirstIndexStatus } from "./first-index-status";
import { buildPathFilter } from "./path-filter";
import { reindexAuditEntry } from "./reindex-audit";

export type { FirstIndexStatus } from "./first-index-status";

/**
 * A grant spelled without its trailing separator. The same folder reaches the
 * agents row both ways — `POST /api/agents` stores `/data/hr/`
 * (`validateAllowedPaths`), the Permissions tab `/data/hr` — and comparing
 * the spellings as strings would call an indexed folder unindexed.
 */
function normalize(path: string): string {
  let out = path;
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return out;
}

/** `path` is `root` or lies inside it — the same boundary buildPathFilter draws. */
function isWithin(path: string, root: string): boolean {
  const p = normalize(path);
  const r = normalize(root);
  return p === r || p.startsWith(r === sep ? r : r + sep);
}

async function hasDocumentsUnder(path: string): Promise<boolean> {
  const [row] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      and(
        eq(kbDocuments.orgId, DEFAULT_ORG_ID),
        buildPathFilter([path], kbDocuments.sourcePath.getSQL())
      )
    )
    .limit(1);
  return row !== undefined;
}

/** Every folder a run was asked to go through, and those of runs that finished. */
export interface RunPaths {
  all: string[];
  finished: string[];
}

/**
 * The folders the org's runs went through — distinct, so the read stays a
 * handful of rows however many nights `kb_index_jobs` has recorded. Read once
 * per question and handed to `neverIndexedPaths`, so asking about every agent
 * is still one read.
 */
export async function loadRunPaths(): Promise<RunPaths> {
  const rows = await db.execute<{ path: string; finished: boolean }>(sql`
    SELECT DISTINCT p.path, (j.status IN ('succeeded', 'failed')) AS finished
    FROM kb_index_jobs j, jsonb_array_elements_text(j.paths) AS p(path)
    WHERE j.org_id = ${DEFAULT_ORG_ID}
  `);
  const list = [...rows];
  return {
    all: [...new Set(list.map((row) => row.path))],
    finished: [...new Set(list.filter((row) => row.finished).map((row) => row.path))],
  };
}

export interface NeverIndexedOptions {
  /**
   * Count only runs that FINISHED as having gone through a folder. Off, a run
   * still waiting or going counts too — which is what keeps a second ask from
   * queueing the same folder twice. On, it answers "is this folder's first
   * index still to come?", for the progress the chat shows.
   */
  finishedOnly?: boolean;
  /** The runs to judge against, when the caller already read them (`loadRunPaths`). */
  runs?: RunPaths;
}

/**
 * The folders among `paths` that no run has gone through.
 *
 * A run of a folder covers everything inside it, so `/data/hr/policies` is
 * indexed once `/data/hr` is — but not the other way round: widening a grant
 * from `/data/hr` to `/data` leaves everything beside `/data/hr` unread. Any
 * agent's run counts, however it ended: the index is the instance's, and a
 * run that failed (an unmounted share, say) is shown where the admin looks at
 * runs and retried by the nightly one — not every ten seconds from here.
 *
 * Documents count only where no run explains them: rows ingested before runs
 * were recorded as jobs. A folder holding those is in the index already.
 */
export async function neverIndexedPaths(
  paths: readonly string[],
  opts: NeverIndexedOptions = {}
): Promise<string[]> {
  if (paths.length === 0) return [];
  const runs = opts.runs ?? (await loadRunPaths());
  const covering = opts.finishedOnly ? runs.finished : runs.all;

  const never: string[] = [];
  for (const path of paths) {
    if (covering.some((root) => isWithin(path, root))) continue;
    const explainedByARun = runs.all.some((runPath) => isWithin(runPath, path));
    if (!explainedByARun && (await hasDocumentsUnder(path))) continue;
    never.push(path);
  }
  return never;
}

const AGENT_COLUMNS = {
  id: agents.id,
  name: agents.name,
  deletedAt: agents.deletedAt,
  allowedTools: agents.allowedTools,
  pluginConfig: agents.pluginConfig,
};

/**
 * The agents that search the index and hold a folder nothing has indexed yet,
 * oldest first — the agents the worker queues a first index for.
 */
export async function agentsOwedFirstIndex(preloaded?: RunPaths): Promise<string[]> {
  const rows = await db
    .select(AGENT_COLUMNS)
    .from(agents)
    .where(isNull(agents.deletedAt))
    .orderBy(asc(agents.createdAt));
  const searching = rows.filter(isScheduledIndexAgent);
  if (searching.length === 0) return [];
  const runs = preloaded ?? (await loadRunPaths());
  const owed: string[] = [];
  for (const agent of searching) {
    if ((await neverIndexedPaths(grantedKnowledgePaths(agent.pluginConfig), { runs })).length > 0) {
      owed.push(agent.id);
    }
  }
  return owed;
}

export interface FirstIndexRequester {
  /** `user` for the admin whose grant it was; `system` for the worker's own look. */
  actorType: "user" | "system";
  /** The admin's id, or the worker's actor name. Also the job's `requestedBy`. */
  actorId: string;
}

export type FirstIndexOutcome =
  /** Queued; the worker runs it next. */
  | { status: "queued"; jobId: string }
  /** The instance's one job slot is taken. The worker queues it once it frees. */
  | { status: "busy" }
  /** Nothing to run: every folder is indexed, the agent does not search, or the run could only fail. */
  | { status: "skipped" };

/**
 * Queues the first index of the agent's folders that nothing has indexed yet,
 * if any — only those, so granting one more folder does not walk the others
 * again.
 *
 * `audit` receives the `knowledge.reindex` rows, so each caller writes them
 * the way its context requires (deferAuditLog in a route, appendAuditLog with
 * recordAuditFailure in the worker). A "busy" answer records nothing: no run
 * was asked for yet, and the row that says one was is written when it is.
 *
 * Without the bundled embedding model the run could only fail, so nothing is
 * queued. The admin whose grant it was is told on the record; the worker's
 * own look stays quiet, since it asks every few seconds until the model is back.
 */
export async function queueFirstIndex(
  agentId: string,
  requester: FirstIndexRequester,
  audit: (entry: AuditLogEntry) => void | Promise<void>,
  /** The runs already read for this look (`loadRunPaths`), so the worker reads them once, not once per agent. */
  runs?: RunPaths
): Promise<FirstIndexOutcome> {
  const [agent] = await db.select(AGENT_COLUMNS).from(agents).where(eq(agents.id, agentId));
  if (!agent || !isScheduledIndexAgent(agent)) return { status: "skipped" };

  const paths = await neverIndexedPaths(grantedKnowledgePaths(agent.pluginConfig), { runs });
  if (paths.length === 0) return { status: "skipped" };

  const agentRef: EntityRef = { id: agent.id, name: agent.name };
  const base = {
    actorType: requester.actorType,
    actorId: requester.actorId,
    agent: agentRef,
    pathCount: paths.length,
    trigger: "initial" as const,
  };

  if (!kbEmbedderAvailable()) {
    if (requester.actorType === "user") {
      await audit(
        reindexAuditEntry({ ...base, outcome: "failure", reason: "embedding_model_missing" })
      );
    }
    return { status: "skipped" };
  }

  if (await findActiveIndexJob(DEFAULT_ORG_ID)) return { status: "busy" };

  let enqueued;
  try {
    enqueued = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: requester.actorId,
      paths,
      trigger: "initial",
    });
  } catch (err) {
    await audit(
      reindexAuditEntry({
        ...base,
        outcome: "failure",
        reason: safeProviderError(err instanceof Error ? err.message : "enqueue_failed"),
      })
    );
    throw err;
  }
  if (enqueued.status === "busy") return { status: "busy" };

  await audit(reindexAuditEntry({ ...base, outcome: "success", jobId: enqueued.job.id }));
  return { status: "queued", jobId: enqueued.job.id };
}

/**
 * Whether the agent's first index is still to come, and how far it has got —
 * what its chat shows, so a fresh agent does not quietly answer "nothing
 * found" while its documents are still being read.
 *
 * Only a FIRST index is reported. A later run (the nightly one, Reindex now)
 * leaves the agent answering from the index it already has, and a chat that
 * said "indexing" through every one of them would read as broken. So progress
 * is shown only for a run that goes through a folder still waiting for its
 * first index — whichever agent asked for it; while some other run holds the
 * instance's one job slot, the answer is `waiting`.
 */
export async function getFirstIndexStatus(agent: {
  id: string;
  deletedAt: Date | null;
  allowedTools: string[];
  pluginConfig: Parameters<typeof grantedKnowledgePaths>[0];
}): Promise<FirstIndexStatus> {
  if (!isScheduledIndexAgent(agent)) return { state: "none" };
  // Without the bundled embedding model no run can start, and a notice that
  // promised one would never come true. The admin is told where runs are
  // looked at; the chat stays quiet.
  if (!kbEmbedderAvailable()) return { state: "none" };
  const granted = grantedKnowledgePaths(agent.pluginConfig);
  const pending = await neverIndexedPaths(granted, { finishedOnly: true });
  if (pending.length === 0) return { state: "none" };
  // Some folders are indexed already: the agent answers from them meanwhile,
  // and the chat says only the new ones are on their way.
  const partial = pending.length < granted.length;

  const active = await findActiveIndexJob(DEFAULT_ORG_ID);
  if (!active) return { state: "queued", partial };
  // Any agent's run counts: an agent created over a folder another agent's
  // first index is reading gets no run of its own — its documents arrive
  // with that one.
  const runsPending = pending.some((path) =>
    active.paths.some((runPath) => isWithin(path, runPath))
  );
  if (!runsPending) return { state: "waiting", partial };
  if (active.status === "running") {
    return { state: "indexing", processed: active.processed, total: active.total, partial };
  }
  return { state: "queued", partial };
}
