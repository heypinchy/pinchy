import type { AgentTemplate } from "../types";

export const CUSTOM_TEMPLATES: Record<string, AgentTemplate> = {
  custom: {
    name: "Custom Agent",
    description: "Start from scratch",
    allowedTools: [],
    pluginId: null,
    defaultPersonality: "the-butler",
    defaultTagline: null,
    defaultAgentsMd: null,
    // Deliberately no modelHint — user-built agent, provider default is appropriate
  },
};
