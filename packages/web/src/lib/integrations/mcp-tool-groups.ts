/**
 * Grouping + filtering helpers for the agent Permissions tab's MCP tool list.
 *
 * An MCP connection can expose 40+ tools (GitHub's server alone advertises ~44).
 * A flat list of raw `snake_case` names with no context is unusable, so we group
 * related tools, show each tool's server-provided description, and make the list
 * searchable.
 *
 * Grouping is by a PRIORITY-ORDERED KEYWORD SCAN over the full tool name, not by
 * position. Earlier attempts split on the first underscore (or skipped a leading
 * CRUD verb and took the next segment) — that keyed on the verb/fragment and
 * produced garbage headers like "Or" (from create_or_update_file), "Me", "Latest",
 * "Label". GitHub's names are verb_noun, so the meaningful key is the DOMAIN NOUN,
 * which can appear anywhere; scanning the whole name for known domain keywords and
 * ignoring the verb eliminates that whole class of noise. Unknown/renamed tools (or
 * a non-GitHub server with no matching keywords) fall back to "Other" — visible,
 * never crashing.
 */

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpToolGroup {
  key: string;
  label: string;
  tools: McpToolInfo[];
}

// First matching rule wins. Order resolves multi-domain names deterministically
// (e.g. search_pull_requests → Pull Requests, not Search; add_comment_to_pending_review
// → Pull Requests via the `review` keyword). `order` fixes the UI ordering; "Other"
// is always last.
interface GroupRule {
  match: RegExp;
  key: string;
  label: string;
  order: number;
}

const GROUP_RULES: GroupRule[] = [
  { match: /secret_scanning/, key: "security", label: "Security", order: 90 },
  { match: /copilot|review/, key: "pull-requests", label: "Pull Requests", order: 10 },
  { match: /pull_request/, key: "pull-requests", label: "Pull Requests", order: 10 },
  { match: /issue|label/, key: "issues", label: "Issues", order: 20 },
  { match: /branch|file/, key: "files", label: "Files & Branches", order: 30 },
  { match: /commit|tag/, key: "commits", label: "Commits & Tags", order: 40 },
  { match: /release/, key: "releases", label: "Releases", order: 50 },
  { match: /repositor|repo|collaborator/, key: "repositories", label: "Repositories", order: 60 },
  { match: /team|user|_me\b/, key: "account", label: "Account & Org", order: 70 },
  { match: /search/, key: "search", label: "Search", order: 80 },
];

const OTHER_GROUP = { key: "other", label: "Other", order: 999 };

/** The group a tool belongs to. Unknown/future tools fall back to "Other". */
export function mcpToolGroup(name: string): { key: string; label: string; order: number } {
  for (const rule of GROUP_RULES) {
    if (rule.match.test(name)) {
      return { key: rule.key, label: rule.label, order: rule.order };
    }
  }
  return OTHER_GROUP;
}

/**
 * Group tools by domain, ordered by `GROUP_RULES` priority (then label), tools
 * sorted by name within each group. Pure + deterministic so it can be unit-tested
 * away from the component.
 */
export function groupMcpTools(tools: McpToolInfo[]): McpToolGroup[] {
  const byKey = new Map<string, { label: string; order: number; tools: McpToolInfo[] }>();
  for (const tool of tools) {
    const g = mcpToolGroup(tool.name);
    const bucket = byKey.get(g.key);
    if (bucket) bucket.tools.push(tool);
    else byKey.set(g.key, { label: g.label, order: g.order, tools: [tool] });
  }

  return Array.from(byKey.entries())
    .map(([key, v]) => ({
      key,
      label: v.label,
      order: v.order,
      tools: [...v.tools].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((g): McpToolGroup => ({ key: g.key, label: g.label, tools: g.tools }));
}

/**
 * Case-insensitive filter across tool name AND description, so a user can find a
 * tool by what it does, not just its exact `snake_case` name.
 */
export function filterMcpTools(tools: McpToolInfo[], query: string): McpToolInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return tools;
  return tools.filter(
    (t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)
  );
}
