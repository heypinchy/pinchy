/**
 * What a Knowledge Base agent can search, folder by folder (#1386).
 *
 * The Index section used to say how far a run had got and nothing about where.
 * An admin with a half-indexed share and a member asking "why doesn't it know
 * about X?" both need the same answer: which folders are searchable, which one
 * the run is in, which are still to come, and which files never made it.
 *
 * Two reads, both scoped by the agent's SAVED grants and nothing else:
 *
 *   - `getKnowledgeFolderStatus`: every granted folder and its immediate
 *     subfolders. Done counts come from kb_documents; expected counts and
 *     "indexing now" from the folder plan the last run recorded
 *     (folder-plan.ts). No filesystem access — this is the read that polls.
 *   - `listKnowledgeFolderFiles`: one folder's files, paginated. This one does
 *     list the folder on disk, because a file the index has no row for is
 *     exactly the file the reader is looking for. It runs on demand, for one
 *     folder, never on the polling path.
 */
import { lstat, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { kbIndexJobs } from "@/db/schema";
import { KB_INDEX_JOB_ACTIVE_STATUSES } from "@/db/enums";
import { realpathWithinDir } from "@/lib/agent-file-access";

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  isAllowedExtension,
  isDenylistedDirName,
  isDenylistedFileName,
  isHiddenSegment,
} from "./exclude-globs";
import {
  currentPlanFolder,
  deriveFolderState,
  folderPlanProgress,
  isAtOrUnder,
  normalizeRoot,
  type FolderPlanSegment,
  type FolderState,
} from "./folder-plan";
import { getLatestIndexJobForAgent, getLatestPlannedIndexJobForAgent } from "./index-jobs";
import { readFromSupersededArtifact } from "./office-format-upgrade";
import { buildPathFilter } from "./path-filter";

export interface FolderStatus {
  path: string;
  /** The last path segment, or the full path for a granted root. */
  name: string;
  state: FolderState;
  /** Documents the index holds under the folder, active or archived. */
  indexed: number;
  /** Of `indexed`, the ones search can use. */
  searchable: number;
  /** Of `indexed`, the ones it cannot: no text, or waiting to be converted again. */
  notSearchable: number;
  /** Files the last run found here; null before any run recorded a folder plan. */
  expected: number | null;
  /** Files the active run has still to reach here; 0 when no run is active. */
  pending: number;
  /** When a run covering this folder last finished; falls back to the newest document in it. */
  lastIndexedAt: string | null;
}

export interface RootFolderStatus extends FolderStatus {
  children: FolderStatus[];
}

export interface FolderStatusResult {
  folders: RootFolderStatus[];
  /** The agent's latest run, or null if it never had one. */
  job: {
    status: "pending" | "running" | "succeeded" | "failed";
    processed: number;
    total: number | null;
    /** The folder the active run is in right now, when it has recorded its plan. */
    currentFolder: string | null;
    finishedAt: string | null;
  } | null;
}

interface CountRow extends Record<string, unknown> {
  child: string;
  in_sub: boolean;
  indexed: string | number;
  not_searchable: string | number;
  last_created: Date | string | null;
}

interface Counts {
  indexed: number;
  notSearchable: number;
  lastCreated: Date | null;
}

const zero = (): Counts => ({ indexed: 0, notSearchable: 0, lastCreated: null });

function addCounts(into: Counts, row: Counts): void {
  into.indexed += row.indexed;
  into.notSearchable += row.notSearchable;
  if (row.lastCreated && (!into.lastCreated || row.lastCreated > into.lastCreated)) {
    into.lastCreated = row.lastCreated;
  }
}

function joinFolder(root: string, segment: string): string {
  return root === "/" ? `/${segment}` : `${root}/${segment}`;
}

/** The first path segment of `path` below `root`, or null when `path` is the root itself. */
function childSegment(root: string, path: string): string | null {
  if (path === root) return null;
  const rest = path.slice(root === "/" ? 1 : root.length + 1);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

// kb_documents' timestamps are `timestamp` without a zone, written as UTC by
// drizzle. A raw query hands them to the driver bare, and the driver reads a
// bare timestamp as LOCAL time — an hour off in Vienna, and every file reads
// "changed". `AT TIME ZONE 'UTC'` makes the zone explicit before it leaves SQL.

/** Done counts under one root, grouped by immediate child — one query per root. */
async function countsUnderRoot(
  orgId: string,
  root: string
): Promise<{ direct: Counts; children: Map<string, Counts> }> {
  const offset = root === "/" ? 2 : root.length + 2;
  const superseded = readFromSupersededArtifact(sql`d.source_path`, sql`d.artifact_format_version`);
  const rows = await db.execute<CountRow>(sql`
    SELECT split_part(substr(d.source_path, ${offset}), '/', 1) AS child,
           strpos(substr(d.source_path, ${offset}), '/') > 0 AS in_sub,
           COUNT(*) AS indexed,
           -- "Has no chunk", correlated on document_id as in unsearchable.ts.
           COUNT(*) FILTER (
             WHERE NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.document_id = d.id)
                OR ${superseded}
           ) AS not_searchable,
           MAX(d.created_at) AT TIME ZONE 'UTC' AS last_created
    FROM kb_documents d
    WHERE d.org_id = ${orgId}
      AND (${buildPathFilter([root], sql`d.source_path`)})
    GROUP BY 1, 2
  `);

  const direct = zero();
  const children = new Map<string, Counts>();
  for (const row of rows) {
    const counts: Counts = {
      indexed: Number(row.indexed),
      notSearchable: Number(row.not_searchable),
      lastCreated: row.last_created ? new Date(row.last_created) : null,
    };
    if (!row.in_sub) {
      addCounts(direct, counts);
      continue;
    }
    const existing = children.get(row.child) ?? zero();
    addCounts(existing, counts);
    children.set(row.child, existing);
  }
  return { direct, children };
}

type FinishedJob = { paths: string[]; finishedAt: Date; startedAt: Date | null };

/**
 * The agent's recent successful runs, newest first. Enough to date every
 * granted folder. A failed run may have read nothing, so it dates nothing.
 */
async function recentFinishedJobs(agentId: string): Promise<FinishedJob[]> {
  const rows = await db
    .select({
      paths: kbIndexJobs.paths,
      finishedAt: kbIndexJobs.finishedAt,
      startedAt: kbIndexJobs.startedAt,
    })
    .from(kbIndexJobs)
    .where(and(eq(kbIndexJobs.agentId, agentId), eq(kbIndexJobs.status, "succeeded")))
    .orderBy(desc(kbIndexJobs.finishedAt))
    .limit(20);
  return rows.filter((row): row is FinishedJob => row.finishedAt !== null);
}

/** The newest successful run whose grants covered `folder`. */
function lastRunCovering(jobs: readonly FinishedJob[], folder: string): FinishedJob | null {
  return jobs.find((job) => job.paths.some((p) => isAtOrUnder(folder, normalizeRoot(p)))) ?? null;
}

/**
 * The run snapshots its paths when it starts. A folder that has left the
 * grants since must not stay on screen as "the folder it is in".
 */
function currentFolderWithin(folder: string | null, roots: readonly string[]): string | null {
  return folder !== null && roots.some((r) => isAtOrUnder(folder, r)) ? folder : null;
}

function uniqueRoots(allowedPaths: readonly string[]): string[] {
  return [...new Set(allowedPaths.map(normalizeRoot))];
}

export async function getKnowledgeFolderStatus(
  orgId: string,
  agentId: string,
  allowedPaths: readonly string[]
): Promise<FolderStatusResult> {
  const roots = uniqueRoots(allowedPaths);
  const [latest, planned, finished] = await Promise.all([
    getLatestIndexJobForAgent(agentId),
    getLatestPlannedIndexJobForAgent(agentId),
    recentFinishedJobs(agentId),
  ]);

  const active =
    latest && (KB_INDEX_JOB_ACTIVE_STATUSES as readonly string[]).includes(latest.status)
      ? latest
      : null;
  const plan: FolderPlanSegment[] | null = planned?.folderPlan ?? null;
  // The plan only says what is still to come when it belongs to the active run.
  // An older run's plan still gives the expected counts.
  const planIsActive = active !== null && planned?.id === active.id;
  const position = planIsActive ? active.processed : null;
  const activeRoots = active ? active.paths.map(normalizeRoot) : [];
  const planRoots = planned ? planned.paths.map(normalizeRoot) : [];

  /**
   * Whether the plan can say how many files `path` holds. It cannot when the
   * planned run never looked there (a grant added since), or when it counted
   * the folder only as part of a subfolder segment above it (a grant narrowed
   * since): a child segment holds that child's whole subtree in one number.
   */
  const planKnows = (path: string): boolean =>
    plan !== null &&
    planRoots.some((r) => isAtOrUnder(path, r)) &&
    !plan.some(
      (s) => s.folder !== path && isAtOrUnder(path, s.folder) && !planRoots.includes(s.folder)
    );

  const statusFor = (path: string, name: string, counts: Counts): FolderStatus => {
    const progress =
      plan && planKnows(path)
        ? folderPlanProgress(plan, path, position)
        : { expected: null, pending: 0, current: false };
    const awaitingDiscovery =
      active !== null &&
      !planIsActive &&
      activeRoots.some((r) => isAtOrUnder(path, r) || isAtOrUnder(r, path));
    const run = lastRunCovering(finished, path);
    const lastIndexed = run?.finishedAt ?? counts.lastCreated;
    return {
      path,
      name,
      state: deriveFolderState({
        indexed: counts.indexed,
        notSearchable: counts.notSearchable,
        expected: progress.expected,
        pending: progress.pending,
        current: progress.current,
        awaitingDiscovery,
      }),
      indexed: counts.indexed,
      searchable: counts.indexed - counts.notSearchable,
      notSearchable: counts.notSearchable,
      expected: progress.expected,
      pending: progress.pending,
      lastIndexedAt: lastIndexed ? lastIndexed.toISOString() : null,
    };
  };

  const folders: RootFolderStatus[] = [];
  for (const root of roots) {
    const { direct, children } = await countsUnderRoot(orgId, root);

    // A subfolder shows up when the index holds something from it or the
    // last run's plan found files in it — whichever knows about it first.
    const names = new Set(children.keys());
    for (const segment of plan ?? []) {
      const child = childSegment(root, segment.folder);
      if (child !== null && isAtOrUnder(segment.folder, root)) names.add(child);
    }

    const total = zero();
    addCounts(total, direct);
    const childStatuses = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const counts = children.get(name) ?? zero();
        addCounts(total, counts);
        return statusFor(joinFolder(root, name), name, counts);
      });

    folders.push({ ...statusFor(root, root, total), children: childStatuses });
  }

  return {
    folders,
    job: latest
      ? {
          status: latest.status,
          processed: latest.processed,
          total: latest.total,
          currentFolder: currentFolderWithin(
            planIsActive && plan && active ? currentPlanFolder(plan, active.processed) : null,
            roots
          ),
          finishedAt: latest.finishedAt ? latest.finishedAt.toISOString() : null,
        }
      : null,
  };
}

// ── Files of one folder ─────────────────────────────────────────────────────

/**
 * - `searchable`: in the index, with text.
 * - `changed`: in the index, but the file was modified after the last run
 *   read it. Search still answers from the old version until the next run.
 * - `no_text`: in the index without searchable text (nearly always a scan).
 * - `awaiting_conversion`: a Word or PowerPoint file search leaves out until
 *   it is converted again.
 * - `pending`: not in the index yet; the active run will get to it.
 * - `failed`: not in the index although the last run saw it.
 * - `new`: not in the index; added after the last run.
 * - `unsupported`: a file type the index does not read.
 */
export type FileState =
  | "searchable"
  | "changed"
  | "no_text"
  | "awaiting_conversion"
  | "pending"
  | "failed"
  | "new"
  | "unsupported";

export interface FolderFile {
  path: string;
  /** The path below the listed folder. */
  name: string;
  state: FileState;
  archived: boolean;
  /** When the current version entered the index. */
  indexedAt: string | null;
  modifiedAt: string | null;
}

export type FileFilter = "all" | "not_searchable";

export interface FolderFilesResult {
  folder: string;
  files: FolderFile[];
  /** Files matching filter and search, before pagination. */
  total: number;
  /** Across the whole folder, regardless of filter and search. */
  totals: { all: number; searchable: number; notSearchable: number };
  /** The folder holds more files than one listing reads; the counts cover the first part only. */
  truncated: boolean;
}

/** How many entries one listing reads before it stops and says so. */
export const MAX_LISTED_FILES = 20_000;

interface Listed {
  path: string;
  supported: boolean;
}

async function listFiles(realDir: string, dir: string, recursive: boolean, out: Listed[]) {
  if (out.length >= MAX_LISTED_FILES) return;
  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- realDir passed realpathWithinDir against a granted root.
    entries = await readdir(realDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= MAX_LISTED_FILES) return;
    // Same rules as ingest's discovery (ingest.ts walkDir/classifyFile): no
    // hidden entries, no denylisted folders or files, never follow a link.
    if (isHiddenSegment(entry.name)) continue;
    if (entry.isDirectory()) {
      if (recursive && !isDenylistedDirName(entry.name)) {
        await listFiles(join(realDir, entry.name), join(dir, entry.name), true, out);
      }
    } else if (entry.isFile()) {
      if (isDenylistedFileName(entry.name)) continue;
      out.push({
        path: join(dir, entry.name),
        supported: isAllowedExtension(entry.name, DEFAULT_ALLOWED_EXTENSIONS),
      });
    }
  }
}

interface DocRow extends Record<string, unknown> {
  source_path: string;
  status: "active" | "archived";
  created_at: Date | string;
  mtime: Date | string | null;
  no_text: boolean;
  superseded: boolean;
}

export interface ListFolderFilesOptions {
  folder: string;
  filter?: FileFilter;
  q?: string;
  offset?: number;
  limit?: number;
}

/**
 * Lists one folder's files with their index state, or null when the folder is
 * not inside the agent's grants (or does not exist) — the caller answers 404
 * either way, so a member cannot probe the share for names.
 *
 * A granted root lists the files directly in it; its subfolders are their own
 * rows in the tree. A subfolder lists everything below it.
 */
export async function listKnowledgeFolderFiles(
  orgId: string,
  agentId: string,
  allowedPaths: readonly string[],
  opts: ListFolderFilesOptions
): Promise<FolderFilesResult | null> {
  const roots = uniqueRoots(allowedPaths);
  const folder = normalizeRoot(opts.folder);
  // Only the normal spelling: `/kb/.` or `/kb//certs` pass a prefix test, but
  // they are not the path the listing builds, so every offset taken from them
  // would point somewhere else.
  if (normalizeRoot(posix.normalize(folder)) !== folder) return null;
  const root = roots.filter((r) => isAtOrUnder(folder, r)).sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  // The same rules as ingest's discovery, applied to the folder asked for: a
  // hidden or OS-junk folder inside the grant (a Samba `.recycle` keeps deleted
  // files under their old names) is not part of what the agent searches.
  const below = folder === root ? [] : folder.slice(root === "/" ? 1 : root.length + 1).split("/");
  if (below.some((segment) => isHiddenSegment(segment) || isDenylistedDirName(segment))) {
    return null;
  }
  const realFolder = await realpathWithinDir(folder, root);
  if (realFolder === null) return null;

  const isRoot = roots.includes(folder);
  const listed: Listed[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- realFolder passed realpathWithinDir against a granted root.
  const info = await lstat(realFolder).catch(() => null);
  if (!info) return null;
  if (info.isFile()) {
    if (isDenylistedFileName(posix.basename(folder))) return null;
    listed.push({
      path: folder,
      supported: isAllowedExtension(folder, DEFAULT_ALLOWED_EXTENSIONS),
    });
  } else {
    await listFiles(realFolder, folder, !isRoot, listed);
  }
  const truncated = listed.length >= MAX_LISTED_FILES;

  const superseded = readFromSupersededArtifact(sql`d.source_path`, sql`d.artifact_format_version`);
  const offset = folder === "/" ? 2 : folder.length + 2;
  const docRows = await db.execute<DocRow>(sql`
    SELECT d.source_path, d.status,
           d.created_at AT TIME ZONE 'UTC' AS created_at,
           d.mtime AT TIME ZONE 'UTC' AS mtime,
           NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.document_id = d.id) AS no_text,
           ${superseded} AS superseded
    FROM kb_documents d
    WHERE d.org_id = ${orgId}
      AND (${buildPathFilter([folder], sql`d.source_path`)})
      ${isRoot ? sql`AND strpos(substr(d.source_path, ${offset}), '/') = 0` : sql``}
  `);
  const docs = new Map(docRows.map((row) => [row.source_path, row]));

  const [latest, finished] = await Promise.all([
    getLatestIndexJobForAgent(agentId),
    recentFinishedJobs(agentId),
  ]);
  const activeCovers =
    latest !== null &&
    (KB_INDEX_JOB_ACTIVE_STATUSES as readonly string[]).includes(latest.status) &&
    latest.paths.some((p) => isAtOrUnder(folder, normalizeRoot(p)));
  const lastRun = lastRunCovering(finished, folder);

  const isSearchable = (file: Listed) => {
    const doc = docs.get(file.path);
    return doc !== undefined && !doc.no_text && !doc.superseded;
  };
  const searchableCount = listed.filter(isSearchable).length;

  const needle = opts.q?.trim().toLowerCase() ?? "";
  const nameOf = (path: string) =>
    path === folder ? path.split("/").pop()! : path.slice(offset - 1);
  const matching = listed.filter(
    (file) =>
      (opts.filter !== "not_searchable" || !isSearchable(file)) &&
      (needle === "" || nameOf(file.path).toLowerCase().includes(needle))
  );

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const start = Math.max(opts.offset ?? 0, 0);
  const page = matching.slice(start, start + limit);

  // Only the page is stat'ed: on a network share a stat per file is a round
  // trip per file, and the states that need a modification time are decided
  // for the rows a reader actually sees.
  const files = await Promise.all(
    page.map(async (file): Promise<FolderFile> => {
      const doc = docs.get(file.path);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- listed below realFolder, which passed realpathWithinDir.
      // lstat: a listed file swapped for a link must not report its target's times.
      const modified = (await lstat(join(realFolder, posix.relative(folder, file.path)))
        .then((s) => s.mtime)
        .catch(() => null)) as Date | null;
      return {
        path: file.path,
        name: nameOf(file.path),
        state: fileState(file, doc, modified, activeCovers, lastRun),
        archived: doc?.status === "archived",
        indexedAt: doc ? new Date(doc.created_at).toISOString() : null,
        modifiedAt: modified ? modified.toISOString() : null,
      };
    })
  );

  return {
    folder,
    files,
    total: matching.length,
    totals: {
      all: listed.length,
      searchable: searchableCount,
      notSearchable: listed.length - searchableCount,
    },
    truncated,
  };
}

/** A second of slack: file systems round modification times differently. */
const MTIME_SLACK_MS = 1000;

function fileState(
  file: Listed,
  doc: DocRow | undefined,
  modified: Date | null,
  activeCovers: boolean,
  lastRun: FinishedJob | null
): FileState {
  if (!file.supported) return "unsupported";
  if (doc) {
    if (doc.superseded) return "awaiting_conversion";
    if (doc.no_text) return "no_text";
    const read = doc.mtime ? new Date(doc.mtime) : null;
    // Changed since the run that last read it. Compared against the last
    // run's start too: a skipped (unchanged-content) file keeps its old
    // mtime on the row, and must stop reading "changed" once a run has
    // looked at it again.
    if (
      modified &&
      read &&
      modified.getTime() > read.getTime() + MTIME_SLACK_MS &&
      (!lastRun?.startedAt || modified > lastRun.startedAt)
    ) {
      return "changed";
    }
    return "searchable";
  }
  if (activeCovers) return "pending";
  if (lastRun?.startedAt && modified && modified < lastRun.startedAt) return "failed";
  return "new";
}
