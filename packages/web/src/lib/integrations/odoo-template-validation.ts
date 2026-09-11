import type { OdooTemplateConfig } from "@/lib/agent-templates";

interface ModelAccessData {
  model: string;
  name: string;
  access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
}

/**
 * A required model the connection has, but on which it may not perform every
 * operation the template needs. `operations` lists only the denied ones.
 */
export interface DeniedModelOperations {
  model: string;
  operations: string[];
}

export interface ValidationResult {
  /**
   * False only when a non-optional required model is absent from the
   * connection's catalogue. This is what gates template availability in
   * `/api/templates` and the Create button in `new-agent-form.tsx`, so a mere
   * operation denial deliberately does NOT flip it — see `deniedOperations`.
   */
  valid: boolean;
  /** Everything the validation had to say, optional models included. */
  warnings: string[];
  availableModels: Array<{ model: string; operations: string[] }>;
  /** Non-optional required models the connection has never been probed for. */
  missingModels: string[];
  /**
   * Non-optional required models the connection HAS, but whose required
   * operations its API user may not perform (heypinchy/pinchy#1208).
   *
   * These used to surface as free-text warnings only, with `valid` left true
   * and the model absent from `missingModels` — so an agent came out with a
   * read-only grant on a model its template needs to write, and the first
   * "Permission denied: write on …" arrived at runtime. Worse, a model with
   * EVERY required operation denied landed in neither `availableModels` nor
   * `missingModels` and disappeared entirely.
   */
  deniedOperations: DeniedModelOperations[];
}

export function validateOdooTemplate(
  templateConfig: OdooTemplateConfig,
  connectionModels: ModelAccessData[]
): ValidationResult {
  const modelMap = new Map(connectionModels.map((m) => [m.model, m]));
  const warnings: string[] = [];
  const availableModels: Array<{ model: string; operations: string[] }> = [];
  const missingModels: string[] = [];
  const deniedOperations: DeniedModelOperations[] = [];

  for (const required of templateConfig.requiredModels) {
    const connectionModel = modelMap.get(required.model);

    if (!connectionModel) {
      warnings.push(`${required.model}: model not available`);
      // Optional models (edition- or module-conditional, e.g. approval.request
      // which exists in Odoo Enterprise but not Community) are surfaced as
      // warnings but do not block agent creation. The agent's AGENTS.md is
      // expected to gate its own usage of these models via `odoo_describe_model` at
      // runtime.
      if (!required.optional) {
        missingModels.push(required.model);
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
    const denied: string[] = [];
    for (const op of required.operations) {
      const key = op as keyof NonNullable<ModelAccessData["access"]>;
      if (connectionModel.access[key]) {
        available.push(op);
      } else {
        denied.push(op);
        warnings.push(`${required.model}: ${op} not available`);
      }
    }

    if (available.length > 0) {
      availableModels.push({ model: required.model, operations: available });
    }

    // Same optional boundary as above: a denial on a module-conditional model
    // is an ordinary fact, and reporting it would train an admin to ignore the
    // signal.
    if (denied.length > 0 && !required.optional) {
      deniedOperations.push({ model: required.model, operations: denied });
    }
  }

  return {
    valid: missingModels.length === 0,
    warnings,
    availableModels,
    missingModels,
    deniedOperations,
  };
}
