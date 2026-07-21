import { TOOL_REGISTRY } from "@/lib/tool-registry";
import type { AgentPluginConfig } from "@/db/schema";

/**
 * Tools an admin marked as requiring inline confirmation for this agent.
 * The policy is agent-level (shared); the grant it produces is per-user.
 */
export function getConfirmTools(pluginConfig: AgentPluginConfig | null | undefined): string[] {
  return pluginConfig?.["pinchy-approvals"]?.confirmTools ?? [];
}

const POWERFUL_TOOL_IDS = new Set(
  TOOL_REGISTRY.filter((t) => t.category === "powerful").map((t) => t.id)
);

/**
 * Auto-default when an admin first enables confirmation: every `powerful`
 * (write/side-effecting) tool the agent is allowed to use. Safe/read-only
 * tools are left ungated so prompts stay rare (approval-fatigue mitigation).
 */
export function defaultConfirmTools(allowedTools: string[]): string[] {
  return allowedTools.filter((id) => POWERFUL_TOOL_IDS.has(id));
}
