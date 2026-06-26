import { githubPrReviewer } from "../mcp/github-pr-reviewer";
import { linearTriage } from "../mcp/linear-triage";
import type { AgentTemplate } from "../types";

// notion-knowledge-keeper is intentionally absent: its `notion` preset isn't
// connectable in Phase 1 (Notion's hosted MCP server is OAuth-only, #339), so
// the template would ship permanently ungated/uninstantiable. The template
// definition + its unit tests stay in ../mcp/notion-knowledge-keeper.ts, ready
// to re-register here once #339 ships a connectable Notion preset.
export const MCP_TEMPLATES: Record<string, AgentTemplate> = {
  "github-pr-reviewer": githubPrReviewer,
  "linear-triage": linearTriage,
};
