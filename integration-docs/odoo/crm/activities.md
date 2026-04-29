---
title: "Activities"
description: "mail.activity model, state computation, activity types, completing activities, and why done activities disappear"
---

## What Activities Are

Activities (`mail.activity`) are scheduled follow-up tasks attached to any Odoo record. They are used across CRM, Sales, Inventory, HR, and most other modules. An activity is linked to its target via `res_model` + `res_id` (polymorphic relation).

## Key Fields

- `res_model`: The model name (e.g., `"crm.lead"`, `"sale.order"`)
- `res_id`: The ID of the target record
- `activity_type_id`: References `mail.activity.type` — predefined types like Email, Phone Call, Meeting, To-Do
- `summary`: Short description of what to do
- `date_deadline`: When the activity is due
- `user_id`: The responsible person

## Activity State

`state` is computed from `date_deadline` relative to today:

| state | Condition |
|---|---|
| `overdue` | `date_deadline < today` |
| `today` | `date_deadline = today` |
| `planned` | `date_deadline > today` |

There is no persistent `state` field — it is always recalculated. Do not filter on `state` in stored queries; filter on `date_deadline` ranges instead.

## Completing an Activity

To mark an activity as done:
- Call the `action_done` method on the activity record, or
- Write `date_done` with today's date and call `_action_done()`

Completed activities are **archived** (moved to `mail.activity.done` or simply deleted depending on version) — they do not remain as active `mail.activity` records. In Odoo 17+, done activities are stored in `mail.activity.done`.

## Querying Activities

Active (pending) activities: search `mail.activity` — all records here are pending.
Done activities (Odoo 17+): search `mail.activity.done`.

## Gotchas

- Completed activities disappear from `mail.activity` — if you need a history, read `mail.activity.done` (Odoo 17+) or the chatter messages (`mail.message` with `subtype_id` pointing to activity subtypes).
- `date_deadline` is a `Date` field, not `Datetime` — time of day is not tracked.
- One record can have multiple activities of different types simultaneously — do not assume one activity per record.
