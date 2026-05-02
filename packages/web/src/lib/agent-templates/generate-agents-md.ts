import type { AgentPluginConfig } from "@/db/schema";
import type { AgentTemplate } from "./types";

/**
 * Generate the AGENTS.md content for an agent.
 *
 * For knowledge-base agents, dynamically includes the allowed paths and
 * explicit tool-use instructions so all models (including OpenAI) know
 * exactly where to look for files instead of guessing paths.
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
    return (
      template.defaultAgentsMd +
      `\n\n## File Access\nYour knowledge base is stored at:\n${pathList}\n\nTool use workflow:\n1. Always start with \`pinchy_ls\` on one of the paths above to discover available files\n2. Use \`pinchy_read\` to read specific files\n3. Never guess file names — always discover them first`
    );
  }

  // Odoo templates render with a top-level heading derived from template.name,
  // so renaming a template in AGENT_TEMPLATES propagates to the heading
  // automatically without touching every raw string.
  if (template.requiresOdooConnection) {
    return `# ${template.name}\n\n${template.defaultAgentsMd}`;
  }

  return template.defaultAgentsMd;
}
