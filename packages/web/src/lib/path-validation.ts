import { resolve, normalize } from "path";

const DATA_ROOT = "/data/";

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
