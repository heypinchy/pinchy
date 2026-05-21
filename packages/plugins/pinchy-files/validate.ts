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
    // Include the allow-list so an LLM that hit a wrong path can retry
    // against the right one without guessing (#418).
    const label = mode === "write" ? "write_paths" : "allowed directories";
    const hint = pathList.length > 0 ? ` (allowed: ${pathList.join(", ")})` : "";
    throw new Error(`Access denied: path not in ${label}${hint}`);
  }

  // Defense in depth: build-time validator enforces write_paths ⊆ allowed_paths,
  // but a tampered or buggy config must not bypass the invariant at runtime.
  if (mode === "write") {
    const inAllowed = config.allowed_paths.some(
      (p) => resolved.startsWith(p) || (resolved + "/").startsWith(p)
    );
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

export { MAX_FILE_SIZE, MAX_PDF_FILE_SIZE };
