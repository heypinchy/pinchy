/**
 * Tests for Task 8.1: recommendedTools support on AgentTemplate
 *
 * Design §4.3 — templates never fail because a provider renamed a tool.
 * Missing tools are silently skipped; the caller receives a list of skipped
 * tools to surface as a non-blocking toast.
 */

import { describe, it, expect } from "vitest";
import type { AgentTemplate, RecommendedTool } from "../types";
import { applyRecommendedTools } from "../recommended-tools";

// ---------------------------------------------------------------------------
// Type-shape tests
// ---------------------------------------------------------------------------

describe("RecommendedTool type", () => {
  it("accepts all four Phase-1 preset ids", () => {
    const tools: RecommendedTool[] = [
      { preset: "github", tool: "get_pull_request" },
      { preset: "notion", tool: "search" },
      { preset: "linear", tool: "create_issue" },
      { preset: "generic", tool: "some_tool" },
    ];
    // TypeScript would catch invalid preset ids at compile time; this test
    // confirms the array is accepted at runtime without throwing.
    expect(tools).toHaveLength(4);
    for (const t of tools) {
      expect(["github", "notion", "linear", "generic"]).toContain(t.preset);
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
        { preset: "github", tool: "get_pull_request" },
        { preset: "github", tool: "list_pull_request_files" },
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
      tools: ["get_pull_request", "list_pull_request_files", "create_review"],
    },
    {
      id: "conn-notion-1",
      preset: "notion" as const,
      tools: ["search", "get_page"],
      // note: update_page is missing
    },
  ];

  it("returns grants for all available tools", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "github", tool: "get_pull_request" },
      { preset: "github", tool: "list_pull_request_files" },
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.grants).toHaveLength(2);
    expect(result.grants).toContainEqual({
      connectionId: "conn-github-1",
      toolName: "get_pull_request",
    });
    expect(result.grants).toContainEqual({
      connectionId: "conn-github-1",
      toolName: "list_pull_request_files",
    });
  });

  it("silently skips tools not in the connection's tool list", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "notion", tool: "search" },
      { preset: "notion", tool: "update_page" }, // not in connection
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].toolName).toBe("search");
  });

  it("records skipped tools when tool is missing from connection", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "notion", tool: "update_page" }, // missing
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ preset: "notion", tool: "update_page" });
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
    const result = applyRecommendedTools([{ preset: "github", tool: "get_pull_request" }], []);
    expect(result.grants).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("picks the first matching connection when multiple connections for a preset exist", () => {
    const multiConnections = [
      {
        id: "conn-github-1",
        preset: "github" as const,
        tools: ["get_pull_request"],
      },
      {
        id: "conn-github-2",
        preset: "github" as const,
        tools: ["get_pull_request", "create_review"],
      },
    ];
    const recommendedTools: RecommendedTool[] = [{ preset: "github", tool: "get_pull_request" }];
    const result = applyRecommendedTools(recommendedTools, multiConnections);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].connectionId).toBe("conn-github-1");
  });

  it("returns grants and skipped without throwing for mixed available/unavailable tools", () => {
    const recommendedTools: RecommendedTool[] = [
      { preset: "github", tool: "get_pull_request" }, // available
      { preset: "github", tool: "nonexistent_tool" }, // unavailable
      { preset: "linear", tool: "create_issue" }, // no connection
    ];
    const result = applyRecommendedTools(recommendedTools, connections);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].toolName).toBe("get_pull_request");
    expect(result.skipped).toHaveLength(2);
  });
});
