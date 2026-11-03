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
 *   - The index worker queues that run at boot rather than waiting for a
 *     nightly reindex that may be switched off (`agentsOwedReconversion`,
 *     `queueReconversion`).
 *   - A superseded artifact directory stays on the volume while a row still
 *     names its version (`officeFormatVersionInUse`).
 *
 * The rows are recognised by their path, with the same rule `isOfficeFile`
 * applies, because the version column alone cannot tell them apart: a row
 * written before the column existed carries null, exactly like a PDF does.
 */
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { agents, kbDocuments } from "@/db/schema";
import { appendAuditLog, safeProviderError, type EntityRef } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

import { DEFAULT_ORG_ID } from "./constants";
import { enqueueIndexJob, findActiveIndexJob } from "./index-jobs";
import { grantedKnowledgePaths } from "./index-schedule";
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

/**
 * Is any Office document still on record as read from an artifact of
 * `version`? Asked of every org: the artifact volume is the instance's.
 */
export async function officeFormatVersionInUse(version: number): Promise<boolean> {
  const [row] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      and(
        isOfficePath(sql`${kbDocuments.sourcePath}`),
        sql`coalesce(${kbDocuments.artifactFormatVersion}, ${sql.raw(
          String(UNRECORDED_ARTIFACT_FORMAT_VERSION)
        )}) = ${version}`
      )
    )
    .limit(1);
  return row !== undefined;
}

/** Does anything under `paths` still need converting again? */
async function owesReconversion(paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  const [row] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      and(
        eq(kbDocuments.orgId, DEFAULT_ORG_ID),
        supersededDocument,
        buildPathFilter(paths, sql`${kbDocuments.sourcePath}`)
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The agents whose granted folders hold an Office document still read from an
 * earlier artifact format, oldest first — the agents a reindex would convert
 * them again for.
 *
 * Every agent with folders, not only those that search: the rows exist because
 * a run indexed them, and until they are converted again the volume keeps the
 * directory they name.
 */
export async function agentsOwedReconversion(): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id, pluginConfig: agents.pluginConfig })
    .from(agents)
    .where(isNull(agents.deletedAt))
    .orderBy(asc(agents.createdAt));
  const owed: string[] = [];
  for (const row of rows) {
    if (await owesReconversion(grantedKnowledgePaths(row.pluginConfig))) owed.push(row.id);
  }
  return owed;
}

/**
 * Queues the reindex that converts an agent's superseded Office documents
 * again — an ordinary `kb_index_jobs` row, run, counted and audited like any
 * other, with trigger `upgrade`.
 *
 * `queued` and `skipped` both mean "this agent is done"; `busy` means the
 * instance's one job slot is taken, so ask again once it is free. Re-checked
 * here rather than trusted from the boot-time list: an agent whose folders
 * overlap one reindexed a moment ago has nothing left to convert, and an
 * agent deleted or stripped of its folders since has nothing to run.
 */
export async function queueReconversion(agentId: string): Promise<"queued" | "busy" | "skipped"> {
  if (await findActiveIndexJob(DEFAULT_ORG_ID)) return "busy";

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      deletedAt: agents.deletedAt,
      pluginConfig: agents.pluginConfig,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent || agent.deletedAt !== null) return "skipped";
  const paths = grantedKnowledgePaths(agent.pluginConfig);
  if (!(await owesReconversion(paths))) return "skipped";

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
    // A database problem, recorded once and left for the next boot or the
    // nightly run — the same call the scheduler makes, for the same reason.
    await audit(
      reindexAuditEntry({
        ...base,
        outcome: "failure",
        reason: safeProviderError(err instanceof Error ? err.message : "enqueue_failed"),
      })
    );
    return "skipped";
  }
  if (enqueued.status === "busy") return "busy";

  await audit(reindexAuditEntry({ ...base, outcome: "success", jobId: enqueued.job.id }));
  return "queued";
}

/** Writes an audit row outside any request — the AGENTS.md non-request pattern. */
async function audit(entry: ReturnType<typeof reindexAuditEntry>): Promise<void> {
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }
}
