export interface AgentTemplate {
  name: string;
  description: string;
  allowedTools: string[];
  pluginId: string | null;
  defaultSoulMd: string;
  defaultGreeting: string | null;
}

export const AGENT_TEMPLATES: Record<string, AgentTemplate> = {
  "knowledge-base": {
    name: "Knowledge Base",
    description: "Answer questions from your docs",
    allowedTools: ["pinchy_ls", "pinchy_read"],
    pluginId: "pinchy-files",
    defaultSoulMd: `<!-- Describe your agent's personality here. For example:
You are a helpful knowledge base assistant. You answer questions
based on the documents available to you. Always cite your sources. -->`,
    defaultGreeting:
      "Hello! I'm your knowledge base assistant. Ask me anything about the documents I have access to.",
  },
  custom: {
    name: "Custom Agent",
    description: "Start from scratch",
    allowedTools: [],
    pluginId: null,
    defaultSoulMd: `<!-- Describe your agent's personality and instructions here. -->`,
    defaultGreeting: null,
  },
};

export function getTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES[id];
}
