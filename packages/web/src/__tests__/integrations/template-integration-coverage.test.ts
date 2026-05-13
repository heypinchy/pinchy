import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { MODEL_CATEGORIES } from "@/lib/integrations/odoo-sync";
import {
  KNOWN_PINCHY_PLUGINS,
  type KnownPinchyPlugin,
} from "@/lib/openclaw-config/plugin-manifest-loader";

/**
 * Generic drift guard for integration plugins that have a "schema sync" —
 * a list of identifiers (Odoo models, email folders, KB paths, …) that
 * Pinchy probes/discovers on the connected system to decide which agent
 * templates are creatable.
 *
 * The bug class this catches:
 *
 *   Two structured lists in the codebase describe the same kind of thing,
 *   and a template only works when both lists agree. Nothing forces the
 *   agreement, so they drift, and templates ship as "features that don't
 *   work" — the Create button stays disabled forever.
 *
 * For Odoo (v0.5.4): `MODEL_CATEGORIES` in `odoo-sync.ts` says which
 * models are probed; `requiredModels` in every Odoo template says which
 * models the template needs. 14 of 22 Odoo templates had at least one
 * required model that was never probed before this guard landed (PR #353).
 *
 * The classification follows the same shape as `EXTERNAL_INTEGRATION_PLUGINS`
 * / `INTERNAL_PLUGINS` in `plugin-manifest-loader.ts`: every plugin in
 * `KNOWN_PINCHY_PLUGINS` MUST appear in exactly one bucket here.
 *   - SCHEMA_SYNC_COVERAGES — plugins where templates declare per-instance
 *     schema requirements that must subset the sync's probe list.
 *   - NO_SCHEMA_REQUIRED — plugins where templates either don't reference
 *     a per-instance schema (e.g. pinchy-email — templates need an email
 *     connection but not specific folders), or the plugin has no probe
 *     list at all (internal plugins).
 *
 * When a new plugin gains a schema sync + template-required schema,
 * move it into SCHEMA_SYNC_COVERAGES and the drift guard runs over it
 * automatically.
 */

interface SchemaSyncCoverage {
  pluginId: KnownPinchyPlugin;
  /** All identifiers the sync probes for this plugin. */
  probedItems: ReadonlySet<string>;
  /**
   * Per template: the identifiers the template declares it needs.
   * `optional` items (e.g. Enterprise-only Odoo models) are EXCLUDED here
   * — those are deliberately tolerated as runtime-missing.
   */
  templates: ReadonlyArray<{ id: string; requiredItems: readonly string[] }>;
}

const odooOptionalModels = (templateId: string): Set<string> => {
  const t = AGENT_TEMPLATES[templateId];
  if (!t?.odooConfig) return new Set();
  return new Set(t.odooConfig.requiredModels.filter((m) => m.optional).map((m) => m.model));
};

const SCHEMA_SYNC_COVERAGES: ReadonlyArray<SchemaSyncCoverage> = [
  {
    pluginId: "pinchy-odoo",
    probedItems: new Set(MODEL_CATEGORIES.flatMap((c) => c.models.map((m) => m.model))),
    templates: Object.entries(AGENT_TEMPLATES)
      .filter(([, t]) => Boolean(t.odooConfig))
      .map(([id, t]) => {
        const optional = odooOptionalModels(id);
        return {
          id,
          requiredItems: t
            .odooConfig!.requiredModels.map((m) => m.model)
            .filter((m) => !optional.has(m)),
        };
      }),
  },
];

const NO_SCHEMA_REQUIRED: ReadonlyArray<KnownPinchyPlugin> = [
  // Internal plugins — no external schema sync, no per-template schema declaration.
  "pinchy-audit",
  "pinchy-context",
  "pinchy-docs",
  "pinchy-files",
  // External plugins without per-template schema requirements (today).
  // pinchy-email: templates declare `requiresEmailConnection: true` but no
  //   `requiredFolders` / `requiredLabels` — any IMAP/Gmail account works.
  //   Move into SCHEMA_SYNC_COVERAGES if/when an email template adds a per-
  //   instance schema requirement.
  "pinchy-email",
  // pinchy-web: web search is provider config (e.g. Brave API key), not a
  //   per-instance schema. No templates declare per-search-engine schemas.
  "pinchy-web",
];

describe("template ↔ integration sync coverage", () => {
  // Exhaustiveness — every known plugin appears in exactly one bucket.
  // Mirrors the EXTERNAL/INTERNAL_PLUGINS pattern in plugin-manifest-loader.ts.
  it("every KNOWN_PINCHY_PLUGINS entry is classified for schema-sync coverage", () => {
    const classified = new Set<KnownPinchyPlugin>([
      ...SCHEMA_SYNC_COVERAGES.map((c) => c.pluginId),
      ...NO_SCHEMA_REQUIRED,
    ]);
    const overlap = SCHEMA_SYNC_COVERAGES.map((c) => c.pluginId).filter((id) =>
      NO_SCHEMA_REQUIRED.includes(id)
    );
    const unclassified = KNOWN_PINCHY_PLUGINS.filter((id) => !classified.has(id));

    expect(overlap, `Plugins in BOTH buckets: ${overlap.join(", ")}`).toEqual([]);
    expect(
      unclassified,
      unclassified.length === 0
        ? ""
        : `\n  New plugin(s) not classified for schema-sync coverage: ${unclassified.join(", ")}\n` +
            `  Either add a SCHEMA_SYNC_COVERAGES entry (if templates declare per-instance schema)\n` +
            `  or add to NO_SCHEMA_REQUIRED (with a comment explaining why).\n`
    ).toEqual([]);
  });

  for (const coverage of SCHEMA_SYNC_COVERAGES) {
    describe(`${coverage.pluginId}`, () => {
      it("probed items are unique (no duplicate identifiers)", () => {
        // Catches accidental copy-paste duplicates that bloat sync calls.
        const counts = new Map<string, number>();
        for (const item of coverage.probedItems) {
          counts.set(item, (counts.get(item) ?? 0) + 1);
        }
        const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([m]) => m);
        expect(dupes, `Duplicate probed items: ${dupes.join(", ")}`).toEqual([]);
      });

      it("no template requires an item the sync doesn't probe", () => {
        const drifts = coverage.templates
          .map((t) => ({
            id: t.id,
            missing: t.requiredItems.filter((item) => !coverage.probedItems.has(item)),
          }))
          .filter((d) => d.missing.length > 0);

        expect(
          drifts,
          drifts.length === 0
            ? ""
            : `\n  These ${coverage.pluginId} templates will ship with a permanently-disabled\n` +
                `  Create button because their required items aren't probed by the sync:\n\n` +
                drifts.map((d) => `    • ${d.id}: ${d.missing.join(", ")}`).join("\n") +
                `\n\n  Fix by either:\n` +
                `    (a) adding the missing items to the sync's probe list, or\n` +
                `    (b) flagging the item \`optional: true\` in the template (runtime-tolerated)\n`
        ).toEqual([]);
      });
    });
  }
});
