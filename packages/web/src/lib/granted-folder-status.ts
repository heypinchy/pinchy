/**
 * Whether each folder an agent is granted is still there (#1363).
 *
 * A grant is a stored path, and nothing ties it to the folder it once named:
 * rename a mount from `/data/old-name` to `/data/new-name` and the agent keeps
 * a grant for a folder that no longer exists, shown in the picker as an
 * ordinary ticked box. This answers, per grant, what an admin needs to decide
 * what to do about it.
 *
 *   - `available`    — a folder Pinchy can open.
 *   - `missing`      — nothing is there, or a file is: the folder is gone.
 *   - `unreadable`   — something is there, but Pinchy is not allowed to open
 *                      it (or a folder above it). Different from `missing`:
 *                      removing the grant would be the wrong fix for a share
 *                      mounted with the wrong owner.
 *   - `link`         — the path runs through a symbolic link. Agents cannot
 *                      read through one (pinchy-files resolves links and then
 *                      checks the grant), and the picker never offers one.
 *   - `outside_data` — not a path under the data root. `grantedDataPaths`
 *                      already drops these; answering here keeps the check
 *                      from ever touching such a path, whatever the caller.
 *
 * The walk is the boundary. It starts at the data root and `lstat`s one
 * component at a time, so it stops AT a link rather than following it: where a
 * link points is never looked at, which is why a dangling link and a working
 * one answer the same. Nothing outside the root is ever touched, and the
 * answer is the status alone — never a resolved target or an error message.
 *
 * Only ever called with the agent's own stored grants; the route takes no
 * path from the request.
 */
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";

import { DATA_ROOT } from "./knowledge/citation-path";

export type GrantedFolderStatus = "available" | "missing" | "unreadable" | "link" | "outside_data";

export interface GrantedFolder {
  /** The grant exactly as stored, so the caller can match it back. */
  path: string;
  status: GrantedFolderStatus;
}

interface CheckOptions {
  /** The data root. Only tests pass this; production always uses `/data/`. */
  root?: string;
}

const GONE_CODES = new Set(["ENOENT", "ENOTDIR"]);
const DENIED_CODES = new Set(["EACCES", "EPERM"]);

export async function checkGrantedFolders(
  paths: readonly string[],
  { root = DATA_ROOT }: CheckOptions = {}
): Promise<GrantedFolder[]> {
  const lexicalRoot = resolve(root);
  let realRoot: string | null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the data root constant (or a test sandbox), never request input.
    realRoot = await realpath(lexicalRoot);
  } catch {
    realRoot = null;
  }
  return Promise.all(
    paths.map(async (path) => ({ path, status: await statusOf(path, lexicalRoot, realRoot) }))
  );
}

async function statusOf(
  path: string,
  lexicalRoot: string,
  realRoot: string | null
): Promise<GrantedFolderStatus> {
  if (typeof path !== "string" || path.includes("\0") || !path.startsWith("/")) {
    return "outside_data";
  }
  const lexical = resolve(normalize(path));
  if (lexical !== lexicalRoot && !lexical.startsWith(lexicalRoot + sep)) return "outside_data";
  // No data root at all (a developer machine): every grant names a folder
  // that is not there.
  if (realRoot === null) return "missing";

  let current = realRoot;
  for (const segment of relative(lexicalRoot, lexical).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- built one component at a time below the real data root; lstat never follows the component it reads.
      const info = await lstat(current);
      if (info.isSymbolicLink()) return "link";
      if (!info.isDirectory()) return "missing";
    } catch (err) {
      return classify(err);
    }
  }

  try {
    // Opening the folder is the question that matters: a folder whose
    // permissions let Pinchy see it but not list it cannot be indexed either.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- every component was lstat'ed above: a real folder below the data root, no link on the way.
    const dir = await opendir(current);
    await dir.close();
    return "available";
  } catch (err) {
    return classify(err);
  }
}

function classify(err: unknown): GrantedFolderStatus {
  const code = (err as NodeJS.ErrnoException)?.code ?? "";
  if (GONE_CODES.has(code)) return "missing";
  if (DENIED_CODES.has(code)) return "unreadable";
  // Anything else (EIO from a dropped network share, ELOOP, …): something is
  // there and could not be opened. Never claim a folder is gone without
  // knowing it — that answer invites removing a grant that still matters.
  return "unreadable";
}
