/**
 * One level of the folder tree below a `/data` mount, for the directory picker
 * (#1269).
 *
 * The top-level mounts come from `listDataMounts`, which reads `/data` itself
 * on every request. Below that, the picker asks for one folder's children at a
 * time, when the admin expands it. Lazy rather than
 * a depth-limited tree on purpose: a customer share can hold tens of thousands
 * of folders on a network drive, and a tree walked up front costs a full
 * directory crawl on every page load to show folders nobody opens.
 *
 * The listing is the boundary, so it is strict:
 *
 *   - The path must sit strictly BELOW the data root after `..`/`.` are
 *     collapsed. The root itself is refused — its children are the mounts, and
 *     those have exactly one source (`listDataMounts`), not two that can
 *     disagree.
 *   - No component below the root may be a symlink. The real path of the
 *     requested folder must equal its lexical path, so a link planted inside a
 *     share cannot be used to browse what it points at — not even somewhere
 *     else inside `/data`, because a folder name the picker shows has to be the
 *     folder the grant names.
 *   - Symlinked CHILDREN are not listed. `Dirent.isDirectory()` describes the
 *     link itself, so a link to a folder is neither a directory nor followed —
 *     the same rule the knowledge-base walk applies (ingest.ts `walkDir`).
 *   - Hidden and OS junk folders are skipped with the index's own predicates,
 *     so the picker never offers a folder whose contents would never be read.
 *
 * The input is never URL-decoded here. The route decodes the query string once;
 * a `%2e%2e` that survives that is a folder name, not a traversal.
 */
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";

import { DATA_ROOT } from "./knowledge/citation-path";
import { isDenylistedDirName, isHiddenSegment } from "./knowledge/exclude-globs";

/**
 * Most folders returned for one parent. A folder with more children than this
 * is a folder an admin scrolls rather than reads; the response says it was cut
 * so the UI can say so too.
 */
export const MAX_LISTED_SUBDIRECTORIES = 500;

export interface DataSubdirectory {
  path: string;
  name: string;
}

export type ListDataSubdirectoriesResult =
  | { ok: true; directories: DataSubdirectory[]; truncated: boolean }
  | { ok: false; reason: "invalid_path" | "not_listable" };

interface ListOptions {
  /** The data root. Only tests pass this; production always uses `/data/`. */
  root?: string;
}

/**
 * The folders directly under the data root — the mounts the picker starts from.
 *
 * Read live, on every call. This list used to come from a file the OpenClaw
 * container wrote at start-up, so a mount that was renamed or deleted stayed
 * on offer until that container restarted — next to the agent's grant for it,
 * which then looked like an ordinary, working folder (#1363). Both containers
 * mount the same `pinchy-data` volume at `/data`, and Docker creates a mount
 * point for every nested mount inside it, so a share mounted on `openclaw`
 * only still appears here (empty), exactly as it did in the old scan.
 *
 * Same rules as one level down: real folders only, no symlinks, no hidden or
 * OS junk folders. A root that cannot be read answers an empty list, which the
 * picker already explains (nothing mounted yet).
 */
export async function listDataMounts({ root = DATA_ROOT }: ListOptions = {}): Promise<
  DataSubdirectory[]
> {
  const lexicalRoot = resolve(root);
  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the data root constant (or a test sandbox), never request input.
    entries = await readdir(lexicalRoot, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn("[data-directories]", `failed to list ${lexicalRoot}:`, code ?? String(err));
    }
    return [];
  }
  return folderNames(entries).map((name) => ({ path: join(lexicalRoot, name), name }));
}

/** Real, visible folders among `entries`, sorted the way a person reads them. */
function folderNames(entries: Dirent[]): string[] {
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !isHiddenSegment(entry.name) && !isDenylistedDirName(entry.name)
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

export async function listDataSubdirectories(
  parent: string,
  { root = DATA_ROOT }: ListOptions = {}
): Promise<ListDataSubdirectoriesResult> {
  if (typeof parent !== "string" || parent.includes("\0") || !parent.startsWith("/")) {
    return { ok: false, reason: "invalid_path" };
  }

  const lexicalRoot = resolve(root);
  const lexical = resolve(normalize(parent));
  if (!lexical.startsWith(lexicalRoot + "/")) {
    return { ok: false, reason: "invalid_path" };
  }

  let realFolder: string;
  try {
    // A real path that differs from the lexical one means some component
    // below the root is a link. Comparing against the root's OWN real path
    // keeps this correct where the root sits under a linked ancestor (macOS
    // `/var` -> `/private/var` in tests) without letting a link below it pass.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the data root constant (or a test sandbox), never request input.
    const realRoot = await realpath(lexicalRoot);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- lexical already passed the root-boundary check above; resolving it IS the symlink check.
    realFolder = await realpath(lexical);
    if (realFolder !== join(realRoot, relative(lexicalRoot, lexical))) {
      return { ok: false, reason: "not_listable" };
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- realFolder equals the boundary-checked lexical path (no link below the root).
    if (!(await stat(realFolder)).isDirectory()) {
      return { ok: false, reason: "not_listable" };
    }
  } catch {
    return { ok: false, reason: "not_listable" };
  }

  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- realFolder equals the boundary-checked lexical path (no link below the root).
    entries = await readdir(realFolder, { withFileTypes: true });
  } catch {
    return { ok: false, reason: "not_listable" };
  }

  const names = folderNames(entries);

  return {
    ok: true,
    truncated: names.length > MAX_LISTED_SUBDIRECTORIES,
    directories: names
      .slice(0, MAX_LISTED_SUBDIRECTORIES)
      .map((name) => ({ path: join(lexical, name), name })),
  };
}
