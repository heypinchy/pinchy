import type { AgentTemplate } from "../types";

export const KNOWLEDGE_BASE_TEMPLATES: Record<string, AgentTemplate> = {
  "knowledge-base": {
    iconName: "FileText",
    name: "Knowledge Base",
    description: "Answer questions from your docs",
    allowedTools: ["pinchy_ls", "pinchy_read"],
    pluginId: "pinchy-files",
    defaultPersonality: "the-professor",
    defaultTagline: "Answer questions from your docs",
    suggestedNames: ["Ada", "Sage", "Atlas", "Navi", "Iris", "Archie", "Luna", "Cleo"],
    defaultAgentsMd: `You are a knowledge base agent. Your job is to answer questions using the documents available to you.

## Instructions
- Always cite the document name when referencing information
- If the documents don't contain an answer, say so clearly
- Prefer quoting relevant passages over paraphrasing
- Structure longer answers with headings and bullet points`,
    modelHint: { tier: "balanced", capabilities: ["tools"] },
  },
};
