import { CUSTOM_TEMPLATES } from "./data/custom";
import { DOCUMENT_TEMPLATES } from "./data/document-agents";
import { EMAIL_TEMPLATES } from "./data/email-agents";
import { KNOWLEDGE_BASE_TEMPLATES } from "./data/knowledge-base";
import { ODOO_TEMPLATES } from "./data/odoo-agents";
import { WEB_TEMPLATES } from "./data/web-agents";
import type { AgentTemplate } from "./types";

// Grants every curated template carries on top of its own tools.
//
// Pinchy's default is that nothing is on, and a from-scratch agent honours that
// literally. A curated template is different: it IS a decision somebody already
// made about what this kind of agent is for, so it may be generous. Memory is
// the clearest case — an assistant that cannot remember anything between
// conversations is not the thing the template promises.
//
// Applied here rather than repeated in ~35 template definitions, so the rule
// has one home and a new template cannot quietly ship without it.
const CURATED_DEFAULT_GRANTS = ["pinchy_memory", "pinchy_write"] as const;

function withCuratedDefaults(
  templates: Record<string, AgentTemplate>
): Record<string, AgentTemplate> {
  return Object.fromEntries(
    Object.entries(templates).map(([id, template]) => [
      id,
      {
        ...template,
        // Merged, never substituted: a template's own integration grants are
        // what make it useful. Deduped, so a template may also name one of
        // these explicitly without ending up with it twice.
        allowedTools: [...new Set([...template.allowedTools, ...CURATED_DEFAULT_GRANTS])],
      },
    ])
  );
}

// Order matters: the template selector grid renders templates in this
// iteration order. Keep `custom` between the document templates and the
// integration-specific (odoo, email, web) templates so it stays visually
// grouped with the "no integration required" templates.
//
// CUSTOM_TEMPLATES is deliberately NOT wrapped — "Start from scratch" means it.
export const AGENT_TEMPLATES: Record<string, AgentTemplate> = {
  ...withCuratedDefaults(KNOWLEDGE_BASE_TEMPLATES),
  ...withCuratedDefaults(DOCUMENT_TEMPLATES),
  ...CUSTOM_TEMPLATES,
  ...withCuratedDefaults(ODOO_TEMPLATES),
  ...withCuratedDefaults(EMAIL_TEMPLATES),
  ...withCuratedDefaults(WEB_TEMPLATES),
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
