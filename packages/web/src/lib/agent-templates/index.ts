export type {
  AgentTemplate,
  OdooAgentTemplateSpec,
  OdooOperation,
  OdooTemplateConfig,
} from "./types";
export { createOdooTemplate, deriveOdooAccessLevel } from "./odoo-factory";
export { generateAgentsMd } from "./generate-agents-md";
export { AGENT_TEMPLATES, getTemplate, getTemplateList, pickSuggestedName } from "./registry";
