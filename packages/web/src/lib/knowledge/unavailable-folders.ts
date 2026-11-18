/**
 * What an admin reads after a reindex that could not read any of the agent's
 * folders (#1363).
 *
 * "None of the granted folders could be read" was true and useless: the
 * admin had to work out which folder was meant and why. A mount renamed from
 * `/data/old-name` to `/data/new-name` left a grant for a folder that no longer
 * existed, and the message gave no hint that the fix was to remove that grant.
 * So this names the folders and says, per reason, what to do:
 *
 *   - `missing`    — gone: remove the grant, or mount the folder again.
 *   - `unreadable` — there, but Pinchy can't open it: a permissions problem on
 *                    the server. Removing the grant would be the wrong fix.
 *   - `emptied`    — came up empty while the index still holds documents from
 *                    it, which is what a share that failed to mount looks like.
 *
 * Only the job's displayed error carries this. The audit row keeps the generic,
 * path-free reason (FOLDERS_UNAVAILABLE_ERROR): a folder path can embed a
 * person's name, and an audit row cannot be rewritten.
 */
import { oneLine } from "../log-line";
import type { SkippedRootReason } from "./ingest";

export interface UnavailableFolder {
  path: string;
  reason: SkippedRootReason;
}

/** Folders named per reason before the rest are counted. */
const NAMED_PER_REASON = 3;
/** Characters of one path the message prints. */
const PATH_MAX = 120;
/**
 * The stored error is cut at 1 KiB (safeProviderError). A message that would
 * be cut names fewer folders instead, so the advice always survives.
 */
const MAX_BYTES = 1000;

const LEAD = "Nothing could be indexed, so the index was left as it was.";

export function describeUnavailableFolders(folders: readonly UnavailableFolder[]): string {
  for (let named = NAMED_PER_REASON; named >= 0; named--) {
    const text = build(folders, named);
    if (Buffer.byteLength(text, "utf8") <= MAX_BYTES) return text;
  }
  return build(folders, 0);
}

function build(folders: readonly UnavailableFolder[], named: number): string {
  const sentences = [LEAD];
  const missing = pathsFor(folders, "missing");
  if (missing.length > 0) {
    sentences.push(
      `${missing.length === 1 ? "Folder" : "Folders"} not found: ${list(missing, named)}. If ${
        missing.length === 1 ? "it was" : "they were"
      } renamed or removed, remove ${
        missing.length === 1 ? "it" : "them"
      } from this agent's Allowed Directories; otherwise mount ${
        missing.length === 1 ? "it" : "them"
      } again.`
    );
  }
  const unreadable = pathsFor(folders, "unreadable");
  if (unreadable.length > 0) {
    sentences.push(
      `Pinchy can't open ${list(unreadable, named)}. Check ${
        unreadable.length === 1 ? "its" : "their"
      } permissions on the server.`
    );
  }
  const emptied = pathsFor(folders, "emptied");
  if (emptied.length > 0) {
    sentences.push(
      `${list(emptied, named)} came up empty, but the index still holds ${
        emptied.length === 1 ? "its" : "their"
      } documents. If ${
        emptied.length === 1 ? "it lives" : "they live"
      } on a network share, check that it is mounted.`
    );
  }
  return sentences.join(" ");
}

function pathsFor(folders: readonly UnavailableFolder[], reason: SkippedRootReason): string[] {
  return folders.filter((folder) => folder.reason === reason).map((folder) => folder.path);
}

function list(paths: readonly string[], named: number): string {
  if (named === 0) return `${paths.length} ${paths.length === 1 ? "folder" : "folders"}`;
  const shown = paths.slice(0, named).map((path) => oneLine(path, PATH_MAX));
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}
