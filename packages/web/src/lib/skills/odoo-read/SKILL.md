---
name: odoo-read
description: Query and summarize data from a connected Odoo instance with the odoo_* read tools (describe, count, read, aggregate). Use whenever an agent needs to look up records, run analytics, or report on Odoo data. Covers the mandatory describe-first workflow, id vs default_code disambiguation, the domain/aggregate query syntax, and how to format results.
---

# Reading Odoo data

You query a connected Odoo instance through a fixed set of read tools —
`odoo_list_models`, `odoo_describe_model`, `odoo_count`, `odoo_read`, and
`odoo_aggregate`. This skill is the shared foundation for every Odoo agent:
how to discover fields, how to write queries, and how to present results.
Model-specific field lists live in each agent's own persona (`## Available
Data`).

## Mandatory Workflow

1. **Always call `odoo_describe_model` first** before querying any model. This gives you the exact field names and types. Never guess field names — they differ from what you might expect (e.g., `product_uom_qty` not `quantity`, `amount_total` not `total`). Use `odoo_list_models` to discover which models are available.
2. Use `odoo_count` to check dataset size before fetching large result sets.
3. Use `odoo_read` for detailed records, `odoo_aggregate` for sums/averages/grouping.

## Identifier Disambiguation (`id` vs `default_code`)

Odoo uses two unrelated identifiers on product-like models, and confusing them is a frequent source of silent search failures (the query returns nothing, the agent guesses, the downstream action lands on the wrong record):

- `id` — Odoo's internal numeric primary key (e.g. `42`). Opaque. Appears in URLs.
- `default_code` — the human-readable internal reference / SKU (e.g. `WIDGET-12`).

When the user mentions a **product reference**, **SKU**, or **"internal reference"**, filter by `default_code`. When they reference **"the record ID"** or paste a **number from a URL**, filter by `id`. Never use one when the user wrote the other.

## Query Syntax Reference

### Filters (domain)

Array of `[field, operator, value]` tuples. Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `not in`, `like`, `ilike`.
Example: `[["state", "=", "sale"], ["date_order", ">=", "2026-01-01"]]`

### odoo_read — order parameter

String with field name and direction: `"date_order desc"` or `"amount_total asc"`.

### odoo_aggregate — groupby and fields

- `groupby`: array of field names, optionally with date granularity: `["partner_id"]`, `["date_order:month"]`, `["date_order:year"]`
- `fields`: array of field names with aggregation operator: `["amount_total:sum"]`, `["partner_id:count_distinct"]`, `["price_unit:avg"]`
- **Important**: The `orderby` parameter in `odoo_aggregate` sorts groups. Use a field from the groupby or an aggregated field: `"amount_total desc"`.
- **Limitation**: You cannot sort aggregation results by a computed aggregate that isn't in the fields list. If you need custom sorting, fetch the groups and sort yourself.

### Example: Revenue by month

```json
{
  "model": "sale.order",
  "filters": [["state", "=", "sale"]],
  "fields": ["amount_total:sum"],
  "groupby": ["date_order:month"]
}
```

### Example: Top customers by revenue

```json
{
  "model": "sale.order",
  "filters": [["state", "=", "sale"]],
  "fields": ["amount_total:sum"],
  "groupby": ["partner_id"],
  "orderby": "amount_total desc",
  "limit": 10
}
```

## Output Formatting

- Use tables for comparisons and rankings
- Use bullet points for summaries
- Always include totals and counts
- Format currency as EUR with 2 decimals
- Format dates as DD.MM.YYYY

## Important Rules

- Never guess or fabricate data — only report what the API returns
- If a query returns too many results, use count first and suggest filters
- If you lack access to a model, say so clearly
- Always state the time period of your analysis
