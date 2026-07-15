export type {
  AgentTemplate,
  OdooAgentTemplateSpec,
  OdooOperation,
  OdooTemplateConfig,
  RecommendedTool,
} from "./types";
export { createOdooTemplate, deriveOdooAccessLevel } from "./odoo-factory";
export { generateAgentsMd } from "./generate-agents-md";
export { AGENT_TEMPLATES, getTemplate, getTemplateList, pickSuggestedName } from "./registry";
export { applyRecommendedTools } from "./recommended-tools";
export type {
  McpConnectionInfo,
  ToolGrant,
  ApplyRecommendedToolsResult,
} from "./recommended-tools";
