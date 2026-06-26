import type { McpTool } from "./types";

export function diffMcpTools(
  before: McpTool[],
  after: McpTool[]
): { added: McpTool[]; removed: McpTool[]; unchanged: McpTool[] } {
  const beforeNames = new Set(before.map((t) => t.name));
  const afterNames = new Set(after.map((t) => t.name));
  return {
    added: after.filter((t) => !beforeNames.has(t.name)),
    removed: before.filter((t) => !afterNames.has(t.name)),
    unchanged: after.filter((t) => beforeNames.has(t.name)),
  };
}
