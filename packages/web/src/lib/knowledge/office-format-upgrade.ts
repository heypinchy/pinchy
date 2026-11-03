/**
 * What an Office artifact format bump owes the documents already indexed.
 *
 * A bump of `OFFICE_ARTIFACT_FORMAT_VERSION` (office-artifacts.ts) means the
 * conversion rules changed because of what an artifact made under the old
 * ones may hold — text a planted document drew in from the server's disk,
 * say. The ingest converts every such document again on its next run
 * (ingest.ts records the version on each row). Until then three things follow,
 * and they live here because each one has to tell the same rows apart:
 *
 *   - Their chunks answer no search (`readFromSupersededArtifact`, used by
 *     retrieve.ts): the text may be exactly what the new rules refuse, and the
 *     preview cannot open their artifact any more anyway.
 *   - The index worker queues that run itself — at boot, and hourly after —
 *     rather than waiting for a nightly reindex that may be switched off
 *     (`agentsOwedReconversion`, `queueReconversion`).
 *   - A superseded artifact directory stays on the volume while a row a
 *     searching agent's folder holds still names its version
 *     (`officeFormatVersionInUse`).
 *
 * Only agents with `knowledge_search` count, as for the nightly run
 * (`isScheduledIndexAgent`): search is scoped by their folders, so a row no
 * such folder holds is one no search reaches and no run converts again. It
 * stays on record, hidden, and is converted once a searching agent is granted
 * its folder — the worker's next hourly look queues that run — but it holds
 * back neither a run nor the removal of the directory it names.
 *
 * The rows are recognised by their path, with the same rule `isOfficeFile`
 * applies, because the version column alone cannot tell them apart: a row
 * written before the column existed carries null, exactly like a PDF does.
 */
import { and, asc, eq, isNull, not, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { agents, kbDocuments } from "@/db/schema";
import { appendAuditLog, safeProviderError, type EntityRef } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

import { DEFAULT_ORG_ID } from "./constants";
import { enqueueIndexJob, findActiveIndexJob } from "./index-jobs";
import { grantedKnowledgePaths, isScheduledIndexAgent } from "./index-schedule";
import { OFFICE_ARTIFACT_FORMAT_VERSION } from "./office-artifacts";
import { OFFICE_EXTENSIONS } from "./office-formats";
import { buildPathFilter } from "./path-filter";
import { KB_INDEX_WORKER_ACTOR, reindexAuditEntry } from "./reindex-audit";

/**
 * The format every Office row written before `artifact_format_version` was
 * recorded was converted under: version 1 was the only one there was.
 */
export const UNRECORDED_ARTIFACT_FORMAT_VERSION = 1;

/**
 * `isOfficeFile`, in SQL: the last path segment ends in an Office extension,
 * case-insensitively, and is more than that extension — a dotfile called
 * `.doc` is not one, exactly as `extensionOf` reads it.
 */
function isOfficePath(sourcePath: SQL): SQL {
  const extensions = OFFICE_EXTENSIONS.map((ext) => ext.slice(1)).join("|");
  return sql`${sourcePath} ~* ${`[^/]\\.(${extensions})$`}`;
}

/**
 * SQL: the document at `sourcePath` is an Office document whose chunks were
 * read from an artifact of an earlier format (`version` is its
 * `artifact_format_version`, null on a row that predates the record).
 */
export function readFromSupersededArtifact(sourcePath: SQL, version: SQL): SQL {
  return sql`(${isOfficePath(sourcePath)} AND ${version} IS DISTINCT FROM ${sql.raw(
    String(OFFICE_ARTIFACT_FORMAT_VERSION)
  )})`;
}

/** The predicate above, against `kb_documents` itself. */
const supersededDocument = readFromSupersededArtifact(
  sql`${kbDocuments.sourcePath}`,
  sql`${kbDocuments.artifactFormatVersion}`
);

/** The agents that search the index, oldest first, each with its folders. */
async function searchingAgents(): Promise<{ id: string; paths: string[] }[]> {
  const rows = await db
    .select({
      id: agents.id,
      deletedAt: agents.deletedAt,
      allowedTools: agents.allowedTools,
      pluginConfig: agents.pluginConfig,
    })
    .from(agents)
    .where(isNull(agents.deletedAt))
    .orderBy(asc(agents.createdAt));
  return rows
    .filter(isScheduledIndexAgent)
    .map((row) => ({ id: row.id, paths: grantedKnowledgePaths(row.pluginConfig) }));
}

/**
 * Is any Office document a searching agent's folder holds still on record as
 * read from an artifact of `version`? Asked of every org: the artifact volume
 * is the instance's.
 */
export async function officeFormatVersionInUse(version: number): Promise<boolean> {
  const paths = (await searchingAgents()).flatMap((agent) => agent.paths);
  if (paths.length === 0) return false;
  const [row] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      and(
        isOfficePath(sql`${kbDocuments.sourcePath}`),
        buildPathFilter(paths, sql`${kbDocuments.sourcePath}`),
        sql`coalesce(${kbDocuments.artifactFormatVersion}, ${sql.raw(
          String(UNRECORDED_ARTIFACT_FORMAT_VERSION)
        )}) = ${version}`
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Does anything under `paths` still need converting again — anything outside
 * `alreadyRun`, the folders an upgrade run has already gone through?
 */
async function owesReconversion(
  paths: readonly string[],
  alreadyRun: readonly string[] = []
): Promise<boolean> {
  if (paths.length === 0) return false;
  const sourcePath = sql`${kbDocuments.sourcePath}`;
  const [row] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      and(
        eq(kbDocuments.orgId, DEFAULT_ORG_ID),
        supersededDocument,
        buildPathFilter(paths, sourcePath),
        alreadyRun.length > 0 ? not(buildPathFilter(alreadyRun, sourcePath)) : undefined
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The searching agents whose granted folders hold an Office document still
 * read from an earlier artifact format, oldest first — the agents a reindex
 * would convert them again for. A document in `alreadyRun`, folders an upgrade
 * run recently went through, does not count.
 */
export async function agentsOwedReconversion(
  alreadyRun: readonly string[] = []
): Promise<string[]> {
  const owed: string[] = [];
  for (const agent of await searchingAgents()) {
    if (await owesReconversion(agent.paths, alreadyRun)) owed.push(agent.id);
  }
  return owed;
}

export type ReconversionOutcome =
  { status: "queued"; paths: string[] } | { status: "busy" } | { status: "skipped" };

/**
 * Queues the reindex that converts an agent's superseded Office documents
 * again — an ordinary `kb_index_jobs` row, run, counted and audited like any
 * other, with trigger `upgrade`.
 *
 * `queued` (with the folders the run will go through) and `skipped` both mean
 * "this agent is done"; `busy` means the instance's one job slot is taken, so
 * ask again once it is free. Re-checked here rather than trusted from the
 * worker's list: an agent deleted, stripped of its folders or of
 * `knowledge_search` since has nothing to run, and an agent whose superseded
 * documents all lie in `alreadyRun` — folders an upgrade run went through
 * within the last day — has nothing a run of its own would change. That
 * second check is not the same as asking the rows again: a document whose
 * conversion ended `infrastructure` (out of memory, a timeout, LibreOffice
 * down) is still superseded after the run, and every other agent granted its
 * folder would otherwise run the whole folder again, every hour.
 */
export async function queueReconversion(
  agentId: string,
  alreadyRun: readonly string[] = []
): Promise<ReconversionOutcome> {
  if (await findActiveIndexJob(DEFAULT_ORG_ID)) return { status: "busy" };

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      deletedAt: agents.deletedAt,
      allowedTools: agents.allowedTools,
      pluginConfig: agents.pluginConfig,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent || !isScheduledIndexAgent(agent)) return { status: "skipped" };
  const paths = grantedKnowledgePaths(agent.pluginConfig);
  if (!(await owesReconversion(paths, alreadyRun))) return { status: "skipped" };

  const agentRef: EntityRef = { id: agent.id, name: agent.name };
  const base = {
    actorType: "system" as const,
    actorId: KB_INDEX_WORKER_ACTOR,
    agent: agentRef,
    pathCount: paths.length,
    trigger: "upgrade" as const,
  };

  let enqueued;
  try {
    enqueued = await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: KB_INDEX_WORKER_ACTOR,
      paths,
      trigger: "upgrade",
    });
  } catch (err) {
    // A database problem, recorded once and left for the worker's next look
    // or the nightly run — the same call the scheduler makes, for the same
    // reason.
    await audit(
      reindexAuditEntry({
        ...base,
        outcome: "failure",
        reason: safeProviderError(err instanceof Error ? err.message : "enqueue_failed"),
      })
    );
    return { status: "skipped" };
  }
  if (enqueued.status === "busy") return { status: "busy" };

  await audit(reindexAuditEntry({ ...base, outcome: "success", jobId: enqueued.job.id }));
  return { status: "queued", paths };
}

/** Writes an audit row outside any request — the AGENTS.md non-request pattern. */
async function audit(entry: ReturnType<typeof reindexAuditEntry>): Promise<void> {
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }
}
