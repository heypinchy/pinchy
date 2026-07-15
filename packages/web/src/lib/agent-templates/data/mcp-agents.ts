import { githubPrReviewer } from "../mcp/github-pr-reviewer";
import { linearTriage } from "../mcp/linear-triage";
import type { AgentTemplate } from "../types";

// notion-knowledge-keeper is intentionally absent: Notion's hosted MCP server
// is OAuth-only as of 2026, which Phase 1 doesn't support — there's no
// connectable "notion" preset in mcp-presets.ts, so a template that
// recommended notion tools would be permanently ungated/uninstantiable (see
// issue #339). Re-add it once a connectable Notion preset ships.
export const MCP_TEMPLATES: Record<string, AgentTemplate> = {
  "github-pr-reviewer": githubPrReviewer,
  "linear-triage": linearTriage,
};
