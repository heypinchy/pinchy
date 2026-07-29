import { resolve, normalize } from "path";

// DATA_ROOT is defined in knowledge/citation-path.ts, not here, and imported
// back — a one-way dependency chosen for a bundling reason, not a layering
// one. citation-path.ts is reached from a client component (the markdown
// renderer, via source-links.ts); this module imports `node:path`, so a
// dependency in the other direction would pull a Node builtin into the browser
// bundle. Re-exported so existing importers of path-validation keep working and
// there is still exactly one definition.
export { DATA_ROOT } from "./knowledge/citation-path";
import { DATA_ROOT } from "./knowledge/citation-path";

export function sanitizePath(inputPath: string): string {
  if (typeof inputPath !== "string") {
    throw new Error("Invalid path: must be a string");
  }

  if (inputPath.includes("\0")) {
    throw new Error("Invalid path: contains null bytes");
  }

  const resolved = resolve(normalize(inputPath));
  const normalized = resolved.endsWith("/") ? resolved : resolved + "/";

  if (!normalized.startsWith(DATA_ROOT)) {
    throw new Error(`Invalid path: must be under ${DATA_ROOT}`);
  }

  return normalized;
}

export function validateAllowedPaths(paths: string[]): string[] {
  if (!Array.isArray(paths)) {
    throw new Error("allowed_paths must be an array");
  }

  if (paths.length === 0) {
    throw new Error("At least one directory is required");
  }

  return paths.map(sanitizePath);
}
