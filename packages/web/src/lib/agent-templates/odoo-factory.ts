import { getOdooToolsForAccessLevel } from "@/lib/tool-registry";
import type { AgentTemplate, OdooAgentTemplateSpec, OdooOperation } from "./types";

export const ODOO_QUERY_INSTRUCTIONS = `## Mandatory Workflow
1. **Always call \`odoo_schema\` first** before querying any model. This gives you the exact field names and types. Never guess field names — they differ from what you might expect (e.g., \`product_uom_qty\` not \`quantity\`, \`amount_total\` not \`total\`).
2. Use \`odoo_count\` to check dataset size before fetching large result sets.
3. Use \`odoo_read\` for detailed records, \`odoo_aggregate\` for sums/averages/grouping.

## Query Syntax Reference
### Filters (domain)
Array of \`[field, operator, value]\` tuples. Operators: \`=\`, \`!=\`, \`>\`, \`>=\`, \`<\`, \`<=\`, \`in\`, \`not in\`, \`like\`, \`ilike\`.
Example: \`[["state", "=", "sale"], ["date_order", ">=", "2026-01-01"]]\`

### odoo_read — order parameter
String with field name and direction: \`"date_order desc"\` or \`"amount_total asc"\`.

### odoo_aggregate — groupby and fields
- \`groupby\`: array of field names, optionally with date granularity: \`["partner_id"]\`, \`["date_order:month"]\`, \`["date_order:year"]\`
- \`fields\`: array of field names with aggregation operator: \`["amount_total:sum"]\`, \`["partner_id:count_distinct"]\`, \`["price_unit:avg"]\`
- **Important**: The \`orderby\` parameter in \`odoo_aggregate\` sorts groups. Use a field from the groupby or an aggregated field: \`"amount_total desc"\`.
- **Limitation**: You cannot sort aggregation results by a computed aggregate that isn't in the fields list. If you need custom sorting, fetch the groups and sort yourself.

### Example: Revenue by month
\`\`\`json
{
  "model": "sale.order",
  "filters": [["state", "=", "sale"]],
  "fields": ["amount_total:sum"],
  "groupby": ["date_order:month"]
}
\`\`\`

### Example: Top customers by revenue
\`\`\`json
{
  "model": "sale.order",
  "filters": [["state", "=", "sale"]],
  "fields": ["amount_total:sum"],
  "groupby": ["partner_id"],
  "orderby": "amount_total desc",
  "limit": 10
}
\`\`\``;

export const ODOO_OUTPUT_FORMATTING = `## Output Formatting
- Use tables for comparisons and rankings
- Use bullet points for summaries
- Always include totals and counts
- Format currency as EUR with 2 decimals
- Format dates as DD.MM.YYYY`;

export const ODOO_RULES = `## Important Rules
- Never guess or fabricate data — only report what the API returns
- If a query returns too many results, use count first and suggest filters
- If you lack access to a model, say so clearly
- Always state the time period of your analysis`;

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
  };
}
