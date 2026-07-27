import type { AgentPluginConfig } from "@/db/schema";
import type { AgentTemplate } from "./types";

/**
 * Generate the AGENTS.md content for an agent.
 *
 * For document-backed agents this appends the granted paths, so a model knows
 * where its documents live instead of guessing at directory names.
 *
 * It deliberately says only WHERE the documents are, never WHICH tool to reach
 * for. This block used to prescribe "1. Always start with `pinchy_ls`", which
 * contradicted the knowledge-base template's own "use `knowledge_search` for
 * any question" — and the numbered, more specific instruction won, so KB agents
 * walked the folder tree instead of searching and produced answers whose
 * sources had no citation numbers (retrieval yields page anchors, reading a
 * file does not).
 *
 * Tool choice belongs in the tool descriptions, which is where a model looks
 * when picking one, and which also covers agents created without a template.
 * `knowledge_search` states its own priority; the pinchy-files tools state only
 * what they do. That split is what keeps the document templates working, since
 * they have no `knowledge_search` and therefore no competing option.
 */
export function generateAgentsMd(
  template: AgentTemplate,
  pluginConfig: AgentPluginConfig | undefined
): string | null {
  if (!template.defaultAgentsMd) return template.defaultAgentsMd;

  if (
    template.pluginId === "pinchy-files" &&
    pluginConfig?.["pinchy-files"]?.allowed_paths?.length
  ) {
    const paths = pluginConfig["pinchy-files"].allowed_paths;
    const pathList = paths.map((p) => `- \`${p}\``).join("\n");
    return template.defaultAgentsMd + `\n\n## Document Access\nYour documents are in:\n${pathList}`;
  }

  // Odoo templates render with a top-level heading derived from template.name,
  // so renaming a template in AGENT_TEMPLATES propagates to the heading
  // automatically without touching every raw string.
  if (template.requiresOdooConnection) {
    return `# ${template.name}\n\n${template.defaultAgentsMd}`;
  }

  return template.defaultAgentsMd;
}
