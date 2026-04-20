---
title: "CRM Pipeline"
description: "crm.lead model, lead vs. opportunity distinction, probability, won/lost logic, and pipeline stage management"
---

## Lead vs. Opportunity

`crm.lead` handles both unqualified leads and sales opportunities via the `type` field:

- `type="lead"`: Unqualified lead — not yet assigned to a sales pipeline stage
- `type="opportunity"`: Qualified opportunity — actively worked in the pipeline

Leads are converted to opportunities via the `convert_opportunity` action, which assigns a `stage_id` and optionally merges duplicates.

## Pipeline Stages

`stage_id` references `crm.stage`. Stage order is controlled by `crm.stage.sequence` — lower sequence = earlier in the pipeline.

- `stage_id.is_won`: If the stage is marked as a won stage, opportunities in it are considered won
- `stage_id.fold`: Folded stages are hidden in the kanban view by default (used for closed/lost stages)

## Probability

`probability` (0–100) represents the estimated win chance:

- Set manually or automatically via Odoo's AI lead scoring (`automated_probability`)
- `probability=100` + `active=true` = **Won**
- `probability=0` + `active=false` = **Lost** (archived)

## Won and Lost Logic

Won/lost is not a simple `state` field — it is controlled by a combination of `probability`, `active`, and `stage_id`:

- **Mark as Won**: Sets `probability=100`, moves to a "won" stage
- **Mark as Lost**: Archives the record (`active=false`), sets `probability=0`, stores `lost_reason_id`

To query won opportunities: filter `active=true` and `probability=100` (or `stage_id.is_won=true`).
To query lost opportunities: filter `active=false`.

## Key Date Fields

- `date_deadline`: Expected closing date (set by salesperson)
- `date_closed`: Actual date the opportunity was won or lost
- `date_conversion`: When the lead was converted to an opportunity

## Gotchas

- Won/lost is driven by `probability` and `active`, **not** by a dedicated stage named "Won" or "Lost" — unless `stage_id.is_won` is configured.
- Archived (`active=false`) records are lost opportunities — default searches exclude them. Add `active=false` to the domain to include them.
- `partner_id` may be empty on leads — use `partner_name` and `email_from` for contact information instead.
