import { getOdooToolsForAccessLevel } from "@/lib/tool-registry";
import type { AgentTemplate, OdooAgentTemplateSpec, OdooOperation } from "./types";

export const ODOO_QUERY_INSTRUCTIONS = `## Mandatory Workflow
1. **Always call \`odoo_describe_model\` first** before querying any model. This gives you the exact field names and types. Never guess field names — they differ from what you might expect (e.g., \`product_uom_qty\` not \`quantity\`, \`amount_total\` not \`total\`). Use \`odoo_list_models\` to discover which models are available.
2. Use \`odoo_count\` to check dataset size before fetching large result sets.
3. Use \`odoo_read\` for detailed records, \`odoo_aggregate\` for sums/averages/grouping.

## Identifier Disambiguation (\`id\` vs \`default_code\`)
Odoo uses two unrelated identifiers on product-like models, and confusing them is a frequent source of silent search failures (the query returns nothing, the agent guesses, the downstream action lands on the wrong record):

- \`id\` — Odoo's internal numeric primary key (e.g. \`42\`). Opaque. Appears in URLs.
- \`default_code\` — the human-readable internal reference / SKU (e.g. \`WIDGET-12\`).

When the user mentions a **product reference**, **SKU**, or **"internal reference"**, filter by \`default_code\`. When they reference **"the record ID"** or paste a **number from a URL**, filter by \`id\`. Never use one when the user wrote the other.

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
 * Shared docstring for read-write Odoo operator templates that call
 * \`odoo_attach_file\`. Explains the ref-flow contract so the LLM doesn't
 * fabricate \`"<model>,<id>"\`-style strings (which the plugin rejects with
 * "Invalid integration reference"). Splice into every template's
 * \`defaultAgentsMd\` that grants attachment permissions.
 */
export const ODOO_ATTACHMENT_REF_FLOW = `## Attaching files to records

Every \`odoo_create\` response includes a \`_pinchy_ref\` field — an opaque token (starting with \`pinchy_ref:v1:\`) that identifies the new record. Pass that value **verbatim** as \`odoo_attach_file.targetRef\`.

The same \`_pinchy_ref\` field appears on every record returned by \`odoo_read\`, so you can attach files to existing records the same way: read the target record, grab its \`_pinchy_ref\`, pass it as \`targetRef\`.

Never construct ref strings yourself. Formats like \`"account.move,37"\`, \`"37"\`, or any other guess will be rejected. The token is encrypted — only the plugin can produce a valid one.`;

/**
 * Multi-Company guidance spliced into accounting templates whose agents act
 * across multiple Odoo companies. Teaches the LLM (a) that records like
 * \`account.move\`, \`account.account\`, \`account.journal\` carry a \`company_id\`,
 * (b) how to read the \`[Company X]\` suffix on \`_pinchy_ref\` labels, and
 * (c) how to react when an m2o lookup fails with a cross-company match.
 */
export const ODOO_MULTI_COMPANY_GUIDANCE = `## Multi-Company

Many accounting records — \`account.move\`, \`account.account\`, \`account.journal\`, \`account.tax\`, \`account.payment\` — carry a \`company_id\`. The same chart of accounts may exist in several companies with identical names ("1000 Wareneinsatz" in GmbH A and GmbH B). To stay accurate:

### Read the label suffix
Every \`_pinchy_ref\` whose source record has a \`company_id\` carries the company in its label: \`"1000 Wareneinsatz [GmbH A]"\`. Use that suffix to confirm you are looking at the right company before passing the ref into a write.

### Filter explicitly when querying
When the user mentions a company (or you already know which one applies), add \`["company_id", "=", <company _pinchy_ref>]\` to your \`odoo_read\` filter. Without that filter, results from every visible company come back interleaved.

### Multi-match errors are usually company collisions
If an \`odoo_create\` or \`odoo_write\` fails with "Could not resolve …: multiple … records match … across companies", the relation lookup found the same display name in two or more companies. Do NOT guess. Instead: \`odoo_read\` on the relation model with a \`company_id\` filter, pick the right \`_pinchy_ref\`, then retry the create.

### Always set \`company_id\` on creates
For models that carry \`company_id\` (every accounting model does), include it explicitly in your \`odoo_create\` values. If you set \`company_id\` to one company but pass a relation ref from another company, the plugin will refuse the write with a "Cross-company write rejected" error — that's the guard catching a real mistake; resolve the relation in the correct company first.

### Ask when in doubt
If the user did not specify which company a booking belongs to, ASK. Never default silently — accounting data crossing the wrong company boundary is the kind of error that compounds across years.`;

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
    allowedTools: [
      ...getOdooToolsForAccessLevel(accessLevel),
      ...(spec.additionalAllowedTools ?? []),
    ],
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
