import { describe, it, expect } from "vitest";
import {
  mcpToolGroup,
  groupMcpTools,
  filterMcpTools,
  type McpToolInfo,
} from "@/lib/integrations/mcp-tool-groups";

// The 44 tool names a live GitHub MCP connection advertises.
const GITHUB_TOOLS = [
  "add_comment_to_pending_review",
  "add_issue_comment",
  "add_reply_to_pull_request_comment",
  "create_branch",
  "create_or_update_file",
  "create_pull_request",
  "create_repository",
  "delete_file",
  "fork_repository",
  "get_commit",
  "get_file_contents",
  "get_label",
  "get_latest_release",
  "get_me",
  "get_release_by_tag",
  "get_tag",
  "get_team_members",
  "get_teams",
  "issue_read",
  "issue_write",
  "list_branches",
  "list_commits",
  "list_issue_fields",
  "list_issues",
  "list_issue_types",
  "list_pull_requests",
  "list_releases",
  "list_repository_collaborators",
  "list_tags",
  "merge_pull_request",
  "pull_request_read",
  "pull_request_review_write",
  "push_files",
  "request_copilot_review",
  "run_secret_scanning",
  "search_code",
  "search_commits",
  "search_issues",
  "search_pull_requests",
  "search_repositories",
  "search_users",
  "sub_issue_write",
  "update_pull_request",
  "update_pull_request_branch",
].map<McpToolInfo>((name) => ({ name, description: `${name} description` }));

describe("mcpToolGroup", () => {
  // The exact cases that the old positional heuristic got wrong — these are the
  // ones that produced the "Or"/"Me"/"Latest"/"Label" garbage headers.
  const cases: Array<[string, string]> = [
    ["create_or_update_file", "Files & Branches"], // was "Or"
    ["get_me", "Account & Org"], // was "Me"
    ["get_latest_release", "Releases"], // was "Latest"
    ["get_label", "Issues"], // was "Label" — labels are an issue concept
    ["add_comment_to_pending_review", "Pull Requests"], // review keyword, no domain noun
    ["search_pull_requests", "Pull Requests"], // pull_request outranks search
    ["get_release_by_tag", "Commits & Tags"], // tag outranks release
    ["run_secret_scanning", "Security"],
    ["get_team_members", "Account & Org"],
  ];
  it.each(cases)("groups %s under %s", (name, label) => {
    expect(mcpToolGroup(name).label).toBe(label);
  });

  it("falls back to Other for an unknown tool name", () => {
    expect(mcpToolGroup("do_something_weird").label).toBe("Other");
    expect(mcpToolGroup("do_something_weird").key).toBe("other");
  });
});

describe("groupMcpTools — GitHub's 44 tools", () => {
  const groups = groupMcpTools(GITHUB_TOOLS);

  it("produces clean domain groups with NO positional-noise labels", () => {
    const labels = groups.map((g) => g.label);
    // Regression guard against the old garbage headers.
    for (const bad of ["Or", "Me", "Latest", "Label", "Get", "List", "Create", "Add"]) {
      expect(labels).not.toContain(bad);
    }
  });

  it("orders groups by priority (Pull Requests first, Other last)", () => {
    const labels = groups.map((g) => g.label);
    expect(labels[0]).toBe("Pull Requests");
    expect(labels.indexOf("Pull Requests")).toBeLessThan(labels.indexOf("Issues"));
    expect(labels.indexOf("Issues")).toBeLessThan(labels.indexOf("Files & Branches"));
  });

  it("places every tool in exactly one group (no drops, no dupes)", () => {
    const placed = groups.flatMap((g) => g.tools.map((t) => t.name)).sort();
    expect(placed).toEqual(GITHUB_TOOLS.map((t) => t.name).sort());
  });

  it("leaves no tool in Other for GitHub (taxonomy covers the catalogue)", () => {
    expect(groups.find((g) => g.key === "other")).toBeUndefined();
  });
});

describe("groupMcpTools — graceful degradation", () => {
  it("collapses a non-GitHub server (no matching keywords) into a single Other group", () => {
    const tools: McpToolInfo[] = [
      { name: "frobnicate", description: "" },
      { name: "wibble_wobble", description: "" },
    ];
    const groups = groupMcpTools(tools);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Other");
    expect(groups[0].tools.map((t) => t.name)).toEqual(["frobnicate", "wibble_wobble"]);
  });

  it("returns an empty array for no tools", () => {
    expect(groupMcpTools([])).toEqual([]);
  });
});

describe("filterMcpTools", () => {
  const tools: McpToolInfo[] = [
    { name: "pull_request_read", description: "Get information on a pull request" },
    { name: "list_issues", description: "List issues in a repository" },
  ];

  it("returns all tools for an empty query", () => {
    expect(filterMcpTools(tools, "  ")).toHaveLength(2);
  });

  it("matches on the tool name", () => {
    expect(filterMcpTools(tools, "pull_request").map((t) => t.name)).toEqual(["pull_request_read"]);
  });

  it("matches on the description (find by what it does, not the snake_case name)", () => {
    expect(filterMcpTools(tools, "repository").map((t) => t.name)).toEqual(["list_issues"]);
  });

  it("is case-insensitive", () => {
    expect(filterMcpTools(tools, "PULL").map((t) => t.name)).toEqual(["pull_request_read"]);
  });
});
