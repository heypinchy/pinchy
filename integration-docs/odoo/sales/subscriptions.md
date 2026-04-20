---
title: "Subscriptions"
description: "Odoo subscription models — Odoo 17+ flag-based vs. Odoo 16 standalone module, key fields, and version detection"
---

## Two Subscription Architectures

Odoo changed its subscription implementation between versions. Before acting on subscriptions, determine which model is available.

### Odoo 17+ — Integrated in sale.order

Subscriptions are regular `sale.order` records with `is_subscription=true`. No separate model exists.

Key fields on `sale.order`:
- `is_subscription`: Boolean — true if this is a recurring order
- `plan_id` (`sale.subscription.plan`): Defines the recurrence (monthly, quarterly, annual)
- `next_invoice_date`: When the next invoice will be generated
- `recurring_monthly`: Normalized monthly revenue (computed)
- `subscription_state`: `"1_draft"`, `"2_renewal"`, `"3_progress"`, `"4_paused"`, `"5_kicked"`, `"6_churn"`, `"7_upsell"`

### Odoo 16 — Standalone sale.subscription

Subscriptions live in a separate model `sale.subscription` with its own state machine:

- `stage_id`: Subscription stage (In Progress, Churned, etc.)
- `recurring_next_date`: Next invoice date
- `recurring_total`: Monthly recurring revenue
- `in_progress`: Computed boolean for active subscriptions

## Version Detection

Use `odoo_schema` to check which model exists:

- If `sale.subscription` returns a schema → Odoo 16 architecture
- If `sale.subscription` returns an error or `is_subscription` exists on `sale.order` → Odoo 17+ architecture

## Recurring Revenue Queries

For Odoo 17+: filter `sale.order` by `is_subscription=true` and `subscription_state="3_progress"` for active subscriptions.

For Odoo 16: filter `sale.subscription` by `in_progress=true` or active stage.

## Gotchas

- In Odoo 17+, cancelled subscriptions remain as `sale.order` records with `subscription_state="6_churn"` — do not filter by `active=false` alone.
- `recurring_monthly` normalizes to monthly regardless of plan — useful for MRR calculations across plans with different billing cycles.
- Never manually set `next_invoice_date` — it is updated automatically after invoice generation.
