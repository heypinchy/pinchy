import path from "node:path";

export type ParsedMemoryPath = { agentId: string; file: string };

export function parseAgentMemoryPath(root: string, absolutePath: string): ParsedMemoryPath | null {
  const normalizedRoot = path.resolve(root);
  const normalizedPath = path.resolve(absolutePath);
  const rel = path.relative(normalizedRoot, normalizedPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  // Layout: `<root>/<agentId>/MEMORY.md` and `<root>/<agentId>/memory/**/*.md`.
  // The watch root IS the workspace base (see workspace.ts), so the agentId is
  // the first segment under the root — there is no `agents/` prefix. Hardcoding
  // `agents/` here is exactly the #345 drift that made the watcher dead code;
  // the round-trip in watcher-path-drift.test.ts pins this to workspace.ts.
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;

  const agentId = parts[0];
  const rest = parts.slice(1);

  if (rest.length === 1 && rest[0] === "MEMORY.md") {
    return { agentId, file: "MEMORY.md" };
  }
  if (rest[0] === "memory" && rest.length >= 2) {
    const lastPart = rest[rest.length - 1];
    if (!lastPart.endsWith(".md")) return null;
    return { agentId, file: rest.join("/") };
  }
  return null;
}
