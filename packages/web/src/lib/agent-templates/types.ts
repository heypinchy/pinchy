import type { PersonalityPresetId } from "@/lib/personality-presets";
import type { TemplateIconName } from "@/lib/template-icons";
import type { ModelHint } from "@/lib/model-resolver/types";

export type OdooOperation = "read" | "create" | "write" | "delete";

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
  suggestedNames?: string[];
  requiresOdooConnection?: boolean;
  requiresEmailConnection?: boolean;
  odooConfig?: OdooTemplateConfig;
  /**
   * Name of the lucide icon (key of TEMPLATE_ICON_COMPONENTS). Required for
   * every template that renders as a card in the selector grid. The `custom`
   * template is the only exception — it renders as a standalone link.
   */
  iconName?: TemplateIconName;
  /** Per-template LLM hint used by the model resolver at agent-creation time. */
  modelHint?: ModelHint;
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
  requiredModels: ReadonlyArray<{
    model: string;
    operations: ReadonlyArray<OdooOperation>;
    optional?: boolean;
  }>;
  modelHint?: ModelHint;
}
