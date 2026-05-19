import { resolve, normalize } from "path";

export const ALLOWED_ROOTS = ["/data/", "/root/.openclaw/workspaces/"] as const;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_PDF_FILE_SIZE = 50 * 1024 * 1024;

export interface AgentFileConfig {
  allowed_paths: string[];
  write_paths?: string[];
  allowed_extensions?: string[];
}

export type AccessMode = "read" | "write";

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
  const allowed = pathList.some(
    (p) => resolved.startsWith(p) || (resolved + "/").startsWith(p)
  );
  if (!allowed) {
    throw new Error(
      mode === "write"
        ? "Access denied: path not in write_paths"
        : "Access denied: path not in allowed directories"
    );
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

export { MAX_FILE_SIZE, MAX_PDF_FILE_SIZE };
