import { githubPrReviewer } from "../mcp/github-pr-reviewer";
import { notionKnowledgeKeeper } from "../mcp/notion-knowledge-keeper";
import { linearTriage } from "../mcp/linear-triage";
import type { AgentTemplate } from "../types";

export const MCP_TEMPLATES: Record<string, AgentTemplate> = {
  "github-pr-reviewer": githubPrReviewer,
  "notion-knowledge-keeper": notionKnowledgeKeeper,
  "linear-triage": linearTriage,
};
