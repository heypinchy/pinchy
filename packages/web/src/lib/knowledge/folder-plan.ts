/**
 * The folder plan of an index run (#1386): which folder each queued file
 * belongs to, recorded once when discovery has walked every root.
 *
 * It answers "how many files does this folder hold?" and "how far has the run
 * got through it?" without walking the share again on every status read. The
 * index only knows the files it has a document row for, so without the plan a
 * folder half-way through its first run would read as complete.
 *
 * The plan is a list of run-length segments in queue order: consecutive files
 * that share a folder collapse into one `{ folder, files }`. Queue order is
 * what makes "indexing now" cheap — the run's `processed` counter is a
 * position in the queue, so the segment holding that position is the folder
 * being worked on, and everything after it is still to come. A folder can
 * appear in more than one segment when the queue visits it twice (files of a
 * folder, then a subfolder, then more files); every reader sums segments.
 *
 * Pure: no database, no filesystem. Shared by the worker that writes the plan
 * and the status read that interprets it.
 */

export interface FolderPlanSegment {
  /** A granted folder, or one of its immediate subfolders. */
  folder: string;
  /** How many consecutive queue entries belong to it. */
  files: number;
}

/** A granted path without a trailing separator, so prefix tests can append one. */
export function normalizeRoot(root: string): string {
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}

/** Whether `path` is `folder` itself or sits anywhere below it. */
export function isAtOrUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : folder + "/");
}

/**
 * The folder a file is counted under: the granted root it sits in, plus the
 * first path segment below that root when the file is inside a subfolder.
 *
 * The deepest containing root wins. With `/data` and `/data/hr` both granted,
 * `/data/hr/policies/a.pdf` is keyed `/data/hr/policies`, which still counts
 * toward `/data`'s `hr` child (a prefix of it) — the shallow root's view loses
 * nothing, and the deep root gets its own children.
 */
export function folderKeyFor(roots: readonly string[], path: string): string | null {
  let best: string | null = null;
  for (const raw of roots) {
    const root = normalizeRoot(raw);
    if (!isAtOrUnder(path, root)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  if (best === null) return null;
  if (path === best) return best;
  const rest = path.slice(best === "/" ? 1 : best.length + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) return best;
  return `${best === "/" ? "" : best}/${rest.slice(0, slash)}`;
}

/** Builds the plan from the run's queue, in queue order. A path outside every root is dropped. */
export function buildFolderPlan(
  roots: readonly string[],
  queuePaths: readonly string[]
): FolderPlanSegment[] {
  const plan: FolderPlanSegment[] = [];
  for (const path of queuePaths) {
    const folder = folderKeyFor(roots, path);
    if (folder === null) continue;
    const last = plan[plan.length - 1];
    if (last && last.folder === folder) last.files++;
    else plan.push({ folder, files: 1 });
  }
  return plan;
}

export interface FolderPlanProgress {
  /** Files the run found under the folder. */
  expected: number;
  /** Of those, the ones the run has not reached yet. */
  pending: number;
  /** Whether the file the run is on right now sits under the folder. */
  current: boolean;
}

/**
 * How a run with this plan stands for one folder, given how many queue
 * entries it has processed. Pass `processed: null` for a run that is over:
 * nothing is pending and nothing is current.
 */
export function folderPlanProgress(
  plan: readonly FolderPlanSegment[],
  folder: string,
  processed: number | null
): FolderPlanProgress {
  let expected = 0;
  let pending = 0;
  let current = false;
  let start = 0;
  for (const segment of plan) {
    const end = start + segment.files;
    if (isAtOrUnder(segment.folder, folder)) {
      expected += segment.files;
      if (processed !== null) {
        pending += Math.max(0, end - Math.max(start, processed));
        if (processed >= start && processed < end) current = true;
      }
    }
    start = end;
  }
  return { expected, pending, current };
}

/** The folder of the file a run is on, or null once it is past the end. */
export function currentPlanFolder(
  plan: readonly FolderPlanSegment[],
  processed: number
): string | null {
  let start = 0;
  for (const segment of plan) {
    const end = start + segment.files;
    if (processed >= start && processed < end) return segment.folder;
    start = end;
  }
  return null;
}

/**
 * What a reader sees for one folder.
 *
 * - `indexing`: the run is working in this folder right now.
 * - `queued`: the run will reach files here, but is not here yet.
 * - `searchable`: every file the last run found here is in the index with text.
 * - `has_errors`: the last run is over, and some file here is not searchable —
 *   it holds no text, waits to be converted again, or never made it in.
 * - `not_indexed`: no run has looked at this folder, and the index holds nothing from it.
 * - `empty`: the last run looked and found no file it could index.
 */
export type FolderState =
  "indexing" | "queued" | "searchable" | "has_errors" | "not_indexed" | "empty";

export interface FolderStateInput {
  /** Documents the index holds under the folder (active or archived). */
  indexed: number;
  /** Of those, the ones search cannot use: no text, or waiting to be converted again. */
  notSearchable: number;
  /** Files the plan says are there; null when no run has recorded a plan for it. */
  expected: number | null;
  /** Files an active run has still to reach here. 0 when no run is active. */
  pending: number;
  /** Whether the active run is in this folder right now. */
  current: boolean;
  /** An active run covers this folder but has not finished discovery yet. */
  awaitingDiscovery: boolean;
}

export function deriveFolderState(input: FolderStateInput): FolderState {
  if (input.current) return "indexing";
  if (input.pending > 0 || input.awaitingDiscovery) return "queued";
  if (input.indexed === 0) {
    if (input.expected === null) return "not_indexed";
    if (input.expected === 0) return "empty";
    return "has_errors";
  }
  if (input.notSearchable > 0) return "has_errors";
  if (input.expected !== null && input.indexed < input.expected) return "has_errors";
  return "searchable";
}
