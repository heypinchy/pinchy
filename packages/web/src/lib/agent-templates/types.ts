import type { PersonalityPresetId } from "@/lib/personality-presets";
import type { TemplateIconName } from "@/lib/template-icons";
import type { ModelHint } from "@/lib/model-resolver/types";
import type { McpPresetId } from "@/lib/integrations/mcp-presets";

export type OdooOperation = "read" | "create" | "write" | "delete";

/**
 * A single tool wish-list entry for an MCP-backed template. At instantiation
 * time (POST /api/agents) the system looks for the first ACTIVE MCP
 * connection of `preset` and checks whether `tool` appears in that
 * connection's discovered tool list (`data.tools`, synced at connect/re-sync
 * time). Missing tools — no matching connection, or the connection never
 * synced this exact tool name — are silently skipped: templates must never
 * fail to create an agent because a provider renamed a tool. See
 * `recommended-tools.ts` for the matching logic.
 *
 * `preset` is typed as `McpPresetId` (derived from `MCP_PRESETS`, the single
 * source of truth in `lib/integrations/mcp-presets.ts`) rather than a
 * hand-rolled union, so a preset that isn't actually connectable (e.g.
 * "notion" — OAuth-only, not yet supported) cannot even type-check here.
 */
export type RecommendedTool = {
  preset: McpPresetId;
  tool: string;
};

export interface OdooTemplateConfig {
  accessLevel: "read-only" | "read-write" | "full";
  requiredModels: Array<{
    model: string;
    operations: OdooOperation[];
    /**
     * Mark a model as optional when it is only present on some Odoo editions
     * or modules (e.g. `approval.request` exists in Odoo Enterprise but not
     * Community). Optional models that are missing from the connection still
     * appear in `warnings`, but they do NOT enter `missingModels` and
     * therefore do not block agent creation in the UI.
     */
    optional?: boolean;
  }>;
}

export interface AgentTemplate {
  name: string;
  description: string;
  allowedTools: string[];
  pluginId: string | null;
  defaultPersonality: PersonalityPresetId;
  defaultTagline: string | null;
  defaultAgentsMd: string | null;
  defaultGreetingMessage?: string;
  /**
   * Clickable starter-prompt chips shown in the empty chat for agents created
   * from this template (#570). Seeded into `agents.starterPrompts` at creation
   * time and editable per agent afterwards. Omit for role-less templates
   * (`custom`) — an agent with no prompts renders no chips.
   */
  defaultStarterPrompts?: string[];
  suggestedNames?: string[];
  requiresOdooConnection?: boolean;
  requiresEmailConnection?: boolean;
  /**
   * The MCP preset this template needs an ACTIVE connection of (e.g.
   * "github", "linear") — not a boolean like `requiresOdooConnection`/
   * `requiresEmailConnection`, because Odoo/email each have exactly one
   * connection *kind*, while MCP has 8 presets. A boolean would collapse
   * "needs a GitHub connection" and "needs a Linear connection" into the
   * same signal, which is exactly the confusion that caused the "Triage
   * talks about Linear with nothing connected" bug this field prevents.
   * `api/templates/route.ts` marks the template unavailable
   * (`unavailableReason: "no-connection"`) unless this preset has at least
   * one connection with `status: "active"` (`getActiveMcpPresets()`).
   */
  requiresMcpConnection?: McpPresetId;
  odooConfig?: OdooTemplateConfig;
  /**
   * Name of the lucide icon (key of TEMPLATE_ICON_COMPONENTS). Required for
   * every template that renders as a card in the selector grid. The `custom`
   * template is the only exception — it renders as a standalone link.
   */
  iconName?: TemplateIconName;
  /** Per-template LLM hint used by the model resolver at agent-creation time. */
  modelHint?: ModelHint;
  /**
   * OpenClaw-native skills the template seeds onto new agents (see master
   * issue #543). Each entry must appear in KNOWN_SKILLS — enforced by the
   * drift-guard test. Pinchy writes the corresponding SKILL.md into the
   * agent's workspace and lists the id under `agents.list[].skills` in
   * openclaw.json. Field is additive: existing templates omit it and behave
   * as before (agent gets skills: [] in DB).
   */
  defaultSkills?: string[];
  /**
   * Optional MCP tool wish-list. At instantiation time the system attempts to
   * grant each listed tool from the first active connection of the matching
   * preset. Tools whose preset has no active connection, or whose name isn't
   * in that connection's discovered tool list, are silently skipped — see
   * `RecommendedTool` above and `recommended-tools.ts`.
   */
  recommendedTools?: RecommendedTool[];
}

/**
 * Declarative spec for an Odoo-backed agent template. Fields that are invariant
 * for every Odoo template (`pluginId`, `requiresOdooConnection`) are set by the
 * factory. Fields that can drift if stated twice (`accessLevel`, `allowedTools`)
 * are derived from the `requiredModels` operations — the operations list is
 * the single source of truth for what the agent is allowed to do.
 */
export interface OdooAgentTemplateSpec {
  iconName: TemplateIconName;
  name: string;
  description: string;
  defaultPersonality: PersonalityPresetId;
  defaultTagline: string;
  suggestedNames: string[];
  defaultGreetingMessage: string;
  defaultAgentsMd: string;
  defaultStarterPrompts?: string[];
  requiredModels: ReadonlyArray<{
    model: string;
    operations: ReadonlyArray<OdooOperation>;
    optional?: boolean;
  }>;
  modelHint?: ModelHint;
}
