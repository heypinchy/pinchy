import { resolve, normalize, dirname, basename, join } from "path";
import { realpathSync } from "fs";

export const ALLOWED_ROOTS = ["/data/", "/root/.openclaw/workspaces/"] as const;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_PDF_FILE_SIZE = 50 * 1024 * 1024;
const MAX_DOCX_FILE_SIZE = 50 * 1024 * 1024;

export interface AgentFileConfig {
  allowed_paths: string[];
  write_paths?: string[];
  allowed_extensions?: string[];
}

export type AccessMode = "read" | "write";

/**
 * Is `resolved` either the directory `dir` itself, or a descendant of it?
 *
 * Treats both inputs as filesystem paths and matches only on directory
 * boundaries. Without this, an allow-list entry like `/foo/uploads` would
 * match any sibling whose name shared the prefix (`/foo/uploadsevil`)
 * because the older raw `startsWith` had no boundary requirement.
 */
function isUnderPath(resolved: string, dir: string): boolean {
  const dirWithSlash = dir.endsWith("/") ? dir : `${dir}/`;
  return (resolved + "/").startsWith(dirWithSlash);
}

/**
 * Resolve symlinks on a write target before it is validated.
 *
 * The read tools already realpath the requested path before calling
 * validateAccess, so a symlink inside an allowed dir pointing outside it is
 * caught by the containment check. The write path validated the lexical path
 * only, so a symlinked ancestor escaping the sandbox would be approved and the
 * subsequent write would follow the link out of bounds. This brings the write
 * path to parity.
 *
 * The target file may not exist yet (create case), so we realpath the deepest
 * EXISTING ancestor and re-append the non-existent tail. If the final component
 * itself is an existing symlink (overwrite case) it is resolved too.
 */
export function realpathWriteTarget(requestedPath: string): string {
  const abs = resolve(normalize(requestedPath));
  const tail: string[] = [];
  let current = abs;
  let parent = dirname(current);
  while (parent !== current) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? join(real, ...tail) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      tail.unshift(basename(current));
      current = parent;
      parent = dirname(current);
    }
  }
  // Reached the filesystem root without finding an existing ancestor.
  return abs;
}

/**
 * Reject a write whose real (symlink-resolved) target escapes every configured
 * write root. The lexical `validateAccess` cannot see a symlinked ancestor that
 * points out of the sandbox; this is the write-path equivalent of the read
 * tools' `realpathSync` step.
 *
 * Compares realpath-to-realpath (the target's resolved path against each
 * resolved write root) so it stays consistent on symlinked roots (e.g. macOS
 * `/var` -> `/private/var`) and only fires on a genuine escape.
 */
export function assertNoSymlinkEscape(requestedPath: string, writePaths: string[]): void {
  const realTarget = realpathWriteTarget(requestedPath);
  const contained = writePaths.some((p) => {
    let realRoot: string;
    try {
      realRoot = realpathSync(p);
    } catch {
      return false;
    }
    return isUnderPath(realTarget, realRoot);
  });
  if (!contained) {
    throw new Error("Access denied: write target escapes the sandbox via a symlink");
  }
}

export function validateAccess(
  config: AgentFileConfig,
  requestedPath: string,
  mode: AccessMode = "read"
): string {
  if (typeof requestedPath !== "string") {
    throw new Error("Invalid path: must be a string");
  }
  if (requestedPath.includes("\0")) {
    throw new Error("Invalid path: contains null bytes");
  }

  const resolved = resolve(normalize(requestedPath));

  const matchedRoot = ALLOWED_ROOTS.find((root) => resolved.startsWith(root));
  if (!matchedRoot) {
    throw new Error("Access denied: path outside allowed roots");
  }

  const pathList = mode === "write" ? (config.write_paths ?? []) : config.allowed_paths;
  const allowed = pathList.some((p) => isUnderPath(resolved, p));
  if (!allowed) {
    // Include the allow-list so an LLM that hit a wrong path can retry
    // against the right one without guessing (#418).
    const label = mode === "write" ? "write_paths" : "allowed directories";
    const hint = pathList.length > 0 ? ` (allowed: ${pathList.join(", ")})` : "";
    throw new Error(`Access denied: path not in ${label}${hint}`);
  }

  // Defense in depth: build-time validator enforces write_paths ⊆ allowed_paths,
  // but a tampered or buggy config must not bypass the invariant at runtime.
  if (mode === "write") {
    const inAllowed = config.allowed_paths.some((p) => isUnderPath(resolved, p));
    if (!inAllowed) {
      throw new Error("Access denied: path not in allowed_paths (subset invariant)");
    }
  }

  const relativeSegments = resolved.slice(matchedRoot.length).split("/");
  if (relativeSegments.some((s) => s.startsWith(".") && s.length > 1)) {
    throw new Error("Hidden files are not accessible");
  }

  if (config.allowed_extensions) {
    const ext = "." + resolved.split(".").pop();
    if (!config.allowed_extensions.includes(ext)) {
      throw new Error(`File type not allowed: ${ext}`);
    }
  }

  return resolved;
}

export { MAX_FILE_SIZE, MAX_PDF_FILE_SIZE, MAX_DOCX_FILE_SIZE };
