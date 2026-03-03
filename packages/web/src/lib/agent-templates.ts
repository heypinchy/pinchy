export interface AgentTemplate {
  name: string;
  description: string;
  allowedTools: string[];
  pluginId: string | null;
  defaultPersonality: string;
  defaultTagline: string | null;
  defaultAgentsMd: string | null;
}

export const AGENT_TEMPLATES: Record<string, AgentTemplate> = {
  "knowledge-base": {
    name: "Knowledge Base",
    description: "Answer questions from your docs",
    allowedTools: ["pinchy_ls", "pinchy_read"],
    pluginId: "pinchy-files",
    defaultPersonality: "the-professor",
    defaultTagline: "Answer questions from your docs",
    defaultAgentsMd: `You are a knowledge base agent. Your job is to answer questions using the documents available to you.

## Instructions
- Always cite the document name when referencing information
- If the documents don't contain an answer, say so clearly
- Prefer quoting relevant passages over paraphrasing
- Structure longer answers with headings and bullet points`,
  },
  custom: {
    name: "Custom Agent",
    description: "Start from scratch",
    allowedTools: [],
    pluginId: null,
    defaultPersonality: "the-butler",
    defaultTagline: null,
    defaultAgentsMd: null,
  },
};

export function getTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES[id];
}

/**
 * Generate the AGENTS.md content for an agent.
 *
 * For knowledge-base agents, dynamically includes the allowed paths and
 * explicit tool-use instructions so all models (including OpenAI) know
 * exactly where to look for files instead of guessing paths.
 */
export function generateAgentsMd(
  template: AgentTemplate,
  pluginConfig: { allowed_paths?: string[] } | undefined
): string | null {
  if (!template.defaultAgentsMd) return template.defaultAgentsMd;

  if (template.pluginId === "pinchy-files" && pluginConfig?.allowed_paths?.length) {
    const paths = pluginConfig.allowed_paths;
    const pathList = paths.map((p) => `- \`${p}\``).join("\n");
    return (
      template.defaultAgentsMd +
      `\n\n## File Access\nYour knowledge base is stored at:\n${pathList}\n\nTool use workflow:\n1. Always start with \`pinchy_ls\` on one of the paths above to discover available files\n2. Use \`pinchy_read\` to read specific files\n3. Never guess file names — always discover them first`
    );
  }

  return template.defaultAgentsMd;
}
