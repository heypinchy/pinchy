/**
 * Tests for the `recommendedTools` wish-list support on AgentTemplate (T9).
 *
 * A template never fails to create an agent because a provider renamed a
 * tool. Missing tools are silently skipped; the caller receives a list of
 * skipped tools to surface as a non-blocking notice.
 */

import { describe, it, expect } from "vitest";
import type { AgentTemplate, RecommendedTool } from "../types";
import { applyRecommendedTools } from "../recommended-tools";
import { MCP_PRESET_IDS } from "@/lib/integrations/mcp-presets";

// ---------------------------------------------------------------------------
// Type-shape tests
// ---------------------------------------------------------------------------

describe("RecommendedTool type", () => {
  it("accepts every connectable MCP preset id (derived from MCP_PRESETS, not a hand-rolled list)", () => {
    const tools: RecommendedTool[] = MCP_PRESET_IDS.map((preset) => ({
      preset,
      tool: "some_tool",
    }));
    // TypeScript would catch invalid preset ids at compile time (e.g.
    // "notion", which has no connectable preset — see mcp-presets.ts); this
    // test confirms every id MCP_PRESETS actually exposes is accepted.
    expect(tools.length).toBe(MCP_PRESET_IDS.length);
    for (const t of tools) {
      expect(MCP_PRESET_IDS, `preset "${t.preset}"`).toContain(t.preset);
      expect(typeof t.tool).toBe("string");
    }
  });
});

describe("AgentTemplate.recommendedTools field", () => {
  it("is optional on AgentTemplate", () => {
    const template: AgentTemplate = {
      name: "Test",
      description: "Test template",
      allowedTools: [],
      pluginId: null,
      defaultPersonality: "the-butler",
      defaultTagline: null,
      defaultAgentsMd: null,
    };
    // No recommendedTools field — should not error
    expect(template.recommendedTools).toBeUndefined();
  });

  it("can carry a recommendedTools array", () => {
    const template: AgentTemplate = {
      name: "Test",
      description: "Test template",
      allowedTools: [],
      pluginId: null,
      defaultPersonality: "the-butler",
      defaultTagline: null,
      defaultAgentsMd: null,
      recommendedTools: [
        { preset: "github", tool: "pull_request_read" },
        { preset: "github", tool: "list_pull_requests" },
      ],
    };
    expect(template.recommendedTools).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// applyRecommendedTools logic tests
// ---------------------------------------------------------------------------

describe("applyRecommendedTools", () => {
  const connections = [
    {
      id: "conn-github-1",
      preset: "github" as const,
      tools: ["pull_request_read", "list_pull_requests", "pull_request_review_write"],
    },
    {
      id: "conn-atlassian-1",
      preset: "atlassian" as const,
      tools: ["search", "get_page"],
      // note: update_page is missing
    },
  ];

  it("returns grants for all available tools", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "github", tool: "pull_request_read" },
      { preset: "github", tool: "list_pull_requests" },
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.grants).toHaveLength(2);
    expect(result.grants).toContainEqual({
      connectionId: "conn-github-1",
      toolName: "pull_request_read",
    });
    expect(result.grants).toContainEqual({
      connectionId: "conn-github-1",
      toolName: "list_pull_requests",
    });
  });

  it("silently skips tools not in the connection's tool list", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "atlassian", tool: "search" },
      { preset: "atlassian", tool: "update_page" }, // not in connection
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].toolName).toBe("search");
  });

  it("records skipped tools when tool is missing from connection", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "atlassian", tool: "update_page" }, // missing
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ preset: "atlassian", tool: "update_page" });
  });

  it("silently skips tools when no connection for that preset exists", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "linear", tool: "create_issue" }, // no linear connection
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.grants).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ preset: "linear", tool: "create_issue" });
  });

  it("does not throw when recommendedTools is empty", () => {
    const result = applyRecommendedTools([], connections);
    expect(result.grants).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("does not throw when connections list is empty", () => {
    const result = applyRecommendedTools([{ preset: "github", tool: "pull_request_read" }], []);
    expect(result.grants).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("picks the first matching connection when multiple connections for a preset exist", () => {
    const multiConnections = [
      {
        id: "conn-github-1",
        preset: "github" as const,
        tools: ["pull_request_read"],
      },
      {
        id: "conn-github-2",
        preset: "github" as const,
        tools: ["pull_request_read", "pull_request_review_write"],
      },
    ];
    const recommendedTools: RecommendedTool[] = [{ preset: "github", tool: "pull_request_read" }];
    const result = applyRecommendedTools(recommendedTools, multiConnections);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].connectionId).toBe("conn-github-1");
  });

  it("returns grants and skipped without throwing for mixed available/unavailable tools", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "github", tool: "pull_request_read" }, // available
      { preset: "github", tool: "nonexistent_tool" }, // unavailable
      { preset: "linear", tool: "create_issue" }, // no connection
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].toolName).toBe("pull_request_read");
    expect(result.skipped).toHaveLength(2);
  });
});
