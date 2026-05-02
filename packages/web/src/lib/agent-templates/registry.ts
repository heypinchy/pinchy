import { CUSTOM_TEMPLATES } from "./data/custom";
import { DOCUMENT_TEMPLATES } from "./data/document-agents";
import { EMAIL_TEMPLATES } from "./data/email-agents";
import { KNOWLEDGE_BASE_TEMPLATES } from "./data/knowledge-base";
import { ODOO_TEMPLATES } from "./data/odoo-agents";
import type { AgentTemplate } from "./types";

// Order matters: the template selector grid renders templates in this
// iteration order. Keep `custom` between the document templates and the
// integration-specific (odoo, email) templates so it stays visually grouped
// with the "no integration required" templates.
export const AGENT_TEMPLATES: Record<string, AgentTemplate> = {
  ...KNOWLEDGE_BASE_TEMPLATES,
  ...DOCUMENT_TEMPLATES,
  ...CUSTOM_TEMPLATES,
  ...ODOO_TEMPLATES,
  ...EMAIL_TEMPLATES,
};

export function getTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES[id];
}

export function getTemplateList(): (AgentTemplate & { id: string })[] {
  return Object.entries(AGENT_TEMPLATES).map(([id, template]) => ({
    id,
    ...template,
  }));
}

/**
 * Pick a suggested name for a new agent, avoiding names already in use.
 * Falls back to appending a number if all suggestions are taken.
 */
export function pickSuggestedName(templateId: string, existingNames: string[]): string {
  const template = AGENT_TEMPLATES[templateId];
  if (!template?.suggestedNames) return "";

  const taken = new Set(existingNames.map((n) => n.toLowerCase()));

  // Try to find an unused name
  const available = template.suggestedNames.find((n) => !taken.has(n.toLowerCase()));
  if (available) return available;

  // All taken — append incrementing number to first name
  const base = template.suggestedNames[0];
  let counter = 2;
  while (taken.has(`${base} ${counter}`.toLowerCase())) {
    counter++;
  }
  return `${base} ${counter}`;
}
