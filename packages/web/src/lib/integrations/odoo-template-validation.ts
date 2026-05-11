import type { OdooTemplateConfig } from "@/lib/agent-templates";

interface ModelAccessData {
  model: string;
  name: string;
  access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
}

interface ValidationResult {
  valid: boolean;
  warnings: string[];
  availableModels: Array<{ model: string; operations: string[] }>;
  missingModels: Array<{ model: string; name: string }>;
}

export function validateOdooTemplate(
  templateConfig: OdooTemplateConfig,
  connectionModels: ModelAccessData[]
): ValidationResult {
  const modelMap = new Map(connectionModels.map((m) => [m.model, m]));
  const warnings: string[] = [];
  const availableModels: Array<{ model: string; operations: string[] }> = [];
  const missingModels: Array<{ model: string; name: string }> = [];

  for (const required of templateConfig.requiredModels) {
    const connectionModel = modelMap.get(required.model);

    if (!connectionModel) {
      warnings.push(`${required.model}: model not available`);
      // Optional models (edition- or module-conditional, e.g. approval.request
      // which exists in Odoo Enterprise but not Community) are surfaced as
      // warnings but do not block agent creation. The agent's AGENTS.md is
      // expected to gate its own usage of these models via `odoo_schema` at
      // runtime.
      if (!required.optional) {
        missingModels.push({
          model: required.model,
          name: required.model, // No display name available when model isn't in connection
        });
      }
      continue;
    }

    // No access field = backward compat, assume full access
    if (!connectionModel.access) {
      availableModels.push({
        model: required.model,
        operations: [...required.operations],
      });
      continue;
    }

    const available: string[] = [];
    for (const op of required.operations) {
      const key = op as keyof NonNullable<ModelAccessData["access"]>;
      if (connectionModel.access[key]) {
        available.push(op);
      } else {
        warnings.push(`${required.model}: ${op} not available`);
      }
    }

    if (available.length > 0) {
      availableModels.push({ model: required.model, operations: available });
    }
  }

  return {
    valid: missingModels.length === 0,
    warnings,
    availableModels,
    missingModels,
  };
}
