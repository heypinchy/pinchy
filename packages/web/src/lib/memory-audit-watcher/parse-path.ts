import path from "node:path";

export type ParsedMemoryPath = { agentId: string; file: string };

export function parseAgentMemoryPath(root: string, absolutePath: string): ParsedMemoryPath | null {
  const normalizedRoot = path.resolve(root);
  const normalizedPath = path.resolve(absolutePath);
  const rel = path.relative(normalizedRoot, normalizedPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  const parts = rel.split(path.sep);
  if (parts.length < 3) return null;
  if (parts[0] !== "agents") return null;

  const agentId = parts[1];
  const rest = parts.slice(2);

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
