import { describe, expect, it } from "vitest";
import { diffMcpTools } from "../mcp-tool-diff";
import type { McpTool } from "../types";

const toolA: McpTool = { name: "toolA", description: "Tool A", inputSchema: {} };
const toolB: McpTool = { name: "toolB", description: "Tool B", inputSchema: {} };
const toolC: McpTool = { name: "toolC", description: "Tool C", inputSchema: {} };

describe("diffMcpTools", () => {
  it("empty/empty → all arrays empty", () => {
    expect(diffMcpTools([], [])).toEqual({ added: [], removed: [], unchanged: [] });
  });

  it("added-only → new tool appears in added", () => {
    expect(diffMcpTools([], [toolA])).toEqual({
      added: [toolA],
      removed: [],
      unchanged: [],
    });
  });

  it("removed-only → missing tool appears in removed", () => {
    expect(diffMcpTools([toolA], [])).toEqual({
      added: [],
      removed: [toolA],
      unchanged: [],
    });
  });

  it("mixed → added, removed, and unchanged correctly classified", () => {
    expect(diffMcpTools([toolA, toolB], [toolB, toolC])).toEqual({
      added: [toolC],
      removed: [toolA],
      unchanged: [toolB],
    });
  });

  it("order-insensitive → swapped order produces all-unchanged result", () => {
    const result = diffMcpTools([toolB, toolA], [toolA, toolB]);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.unchanged).toHaveLength(2);
  });

  it("idempotent → calling with same inputs twice gives same result", () => {
    const r1 = diffMcpTools([toolA, toolB], [toolB, toolC]);
    const r2 = diffMcpTools([toolA, toolB], [toolB, toolC]);
    expect(r1).toEqual(r2);
  });
});
