import { getOdooToolsForAccessLevel } from "@/lib/tool-registry";
import type { AgentTemplate, OdooAgentTemplateSpec, OdooOperation } from "./types";

/**
 * Derive the minimal Odoo access level that satisfies the given per-model
 * operations. `delete` requires `full`, `create`/`write` require `read-write`,
 * everything else is `read-only`. This is the inverse of
 * `getOdooToolsForAccessLevel` and guarantees the template's declared level
 * cannot drift from the operations it actually requests.
 */
export function deriveOdooAccessLevel(
  requiredModels: ReadonlyArray<{ operations: ReadonlyArray<OdooOperation> }>
): "read-only" | "read-write" | "full" {
  let hasWrite = false;
  for (const m of requiredModels) {
    for (const op of m.operations) {
      if (op === "delete") return "full";
      if (op === "create" || op === "write") hasWrite = true;
    }
  }
  return hasWrite ? "read-write" : "read-only";
}

/**
 * Factory for Odoo-backed agent templates. Eliminates the four fields that
 * used to be restated on every Odoo template (`pluginId`, `allowedTools`,
 * `requiresOdooConnection`, `odooConfig.accessLevel`) by deriving them from
 * the `requiredModels` operations — the only field that carries per-template
 * information. Preserves every caller-provided field verbatim so the rendered
 * AGENTS.md output is byte-identical to a hand-written template.
 */
export function createOdooTemplate(spec: OdooAgentTemplateSpec): AgentTemplate {
  const accessLevel = deriveOdooAccessLevel(spec.requiredModels);
  return {
    iconName: spec.iconName,
    name: spec.name,
    description: spec.description,
    allowedTools: getOdooToolsForAccessLevel(accessLevel),
    pluginId: null,
    defaultPersonality: spec.defaultPersonality,
    defaultTagline: spec.defaultTagline,
    suggestedNames: [...spec.suggestedNames],
    defaultGreetingMessage: spec.defaultGreetingMessage,
    defaultAgentsMd: spec.defaultAgentsMd,
    ...(spec.defaultStarterPrompts !== undefined
      ? { defaultStarterPrompts: [...spec.defaultStarterPrompts] }
      : {}),
    requiresOdooConnection: true,
    odooConfig: {
      accessLevel,
      requiredModels: spec.requiredModels.map((m) => ({
        model: m.model,
        operations: [...m.operations],
        ...(m.optional ? { optional: true } : {}),
      })),
    },
    ...(spec.modelHint !== undefined ? { modelHint: spec.modelHint } : {}),
    ...(spec.defaultSkills !== undefined ? { defaultSkills: [...spec.defaultSkills] } : {}),
  };
}
