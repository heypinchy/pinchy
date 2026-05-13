import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { MODEL_CATEGORIES } from "@/lib/integrations/odoo-sync";

/**
 * Drift guard: every non-optional model declared in an Odoo template's
 * `requiredModels` must also appear in `odoo-sync.ts`'s `MODEL_CATEGORIES`.
 *
 * `odoo-sync.ts` is the curated probe list that decides which models the
 * schema sync touches. `odoo-template-validation.ts` then checks each
 * template's `requiredModels` against the synced result to enable/disable
 * the **Create** button in the new-agent picker.
 *
 * If a template requires `hr.expense.sheet` but `odoo-sync.ts` never probes
 * it, the model will always look "missing" after a fresh sync — and the
 * template's **Create** button stays disabled forever, regardless of what
 * the connected Odoo instance actually exposes. That's a silent broken
 * feature: it shipped, it's listed in the picker, and no user can use it.
 *
 * This test makes the contract loud: adding a template with a model that
 * isn't probed is a test failure, not a user-discovered bug.
 *
 * Models flagged `optional: true` are exempt — those are the cases like
 * `approval.request` (Odoo Enterprise only) where we deliberately tolerate
 * absence at runtime (warning, not block).
 */
describe("Odoo template requiredModels are covered by odoo-sync MODEL_CATEGORIES", () => {
  const probedModels = new Set<string>(
    MODEL_CATEGORIES.flatMap((cat) => cat.models.map((m) => m.model))
  );

  it("every probed model is unique (no duplicate entries in MODEL_CATEGORIES)", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const cat of MODEL_CATEGORIES) {
      for (const { model } of cat.models) {
        if (seen.has(model)) duplicates.push(model);
        seen.add(model);
      }
    }
    expect(duplicates, `MODEL_CATEGORIES duplicates: ${duplicates.join(", ")}`).toEqual([]);
  });

  const drifts: Array<{ template: string; missing: string[] }> = [];
  for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
    const cfg = template.odooConfig;
    if (!cfg) continue;
    const missing = cfg.requiredModels
      .filter((rm) => !rm.optional)
      .map((rm) => rm.model)
      .filter((model) => !probedModels.has(model));
    if (missing.length > 0) drifts.push({ template: id, missing });
  }

  it("no template requires a non-optional model that odoo-sync doesn't probe", () => {
    expect(
      drifts,
      drifts.length === 0
        ? ""
        : `\n  The Create button in the new-agent picker will be permanently disabled for these templates ` +
            `because their non-optional requiredModels are not in odoo-sync.ts MODEL_CATEGORIES:\n` +
            drifts.map((d) => `    • ${d.template}: ${d.missing.join(", ")}`).join("\n") +
            `\n\n  Fix: add the missing models to the appropriate MODEL_CATEGORIES entry in ` +
            `packages/web/src/lib/integrations/odoo-sync.ts (or flag them \`optional: true\` ` +
            `in the template if their absence should be tolerated at runtime).\n`
    ).toEqual([]);
  });
});
