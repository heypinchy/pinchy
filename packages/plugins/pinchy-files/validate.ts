import { resolve, normalize } from "path";

const DATA_ROOT = "/data/";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export interface AgentFileConfig {
  allowed_paths: string[];
  allowed_extensions?: string[];
}

export function validateAccess(
  config: AgentFileConfig,
  requestedPath: string
): string {
  if (typeof requestedPath !== "string") {
    throw new Error("Invalid path: must be a string");
  }

  if (requestedPath.includes("\0")) {
    throw new Error("Invalid path: contains null bytes");
  }

  const resolved = resolve(normalize(requestedPath));

  if (!resolved.startsWith(DATA_ROOT)) {
    throw new Error("Access denied: path outside data directory");
  }

  const allowed = config.allowed_paths.some(
    (p) => resolved.startsWith(p) || (resolved + "/").startsWith(p)
  );
  if (!allowed) {
    throw new Error("Access denied: path not in allowed directories");
  }

  const segments = resolved.split("/");
  if (segments.some((s) => s.startsWith(".") && s.length > 1)) {
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

export { MAX_FILE_SIZE };
