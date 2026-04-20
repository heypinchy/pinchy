---
title: "Tasks and Timesheets"
description: "project.task kanban state, closed stage detection, planned vs. effective hours, and timesheet-driven hour tracking"
---

## Task Fields

`project.task` represents a unit of work within a project:

- `project_id`: The parent project
- `stage_id`: Current kanban stage (`project.task.type`)
- `user_ids`: Assigned team members (many2many in Odoo 16+; `user_id` in older versions)
- `date_deadline`: When the task should be completed
- `date_assign`: When the task was last assigned
- `date_end`: When the task was marked done (set automatically)

## Kanban State vs. Stage

Two separate signals for task readiness:

- `kanban_state`: Manual readiness indicator
  - `"normal"`: In progress, no blocker
  - `"done"`: Ready for next stage (green dot)
  - `"blocked"`: Blocked (red dot)
- `stage_id`: The current workflow stage — moves left to right as work progresses

## Identifying Closed/Open Tasks

`stage_id.fold=true` marks a stage as "folded" in the kanban view — typically used for final/closed stages (Done, Cancelled). Use this to filter open tasks:

```
[("stage_id.fold", "=", false)]
```

There is no dedicated `is_closed` boolean — always use `stage_id.fold`.

## Planned vs. Effective Hours

- `planned_hours`: Estimated hours (set manually by assignee or manager)
- `effective_hours`: Actual hours logged via timesheets (computed from `account.analytic.line`)
- `remaining_hours`: `planned_hours - effective_hours` (computed; can go negative)
- `overtime`: `effective_hours - planned_hours` (computed)

`effective_hours` is **not directly editable** — it is the sum of timesheet lines. To add hours, create `account.analytic.line` records with `task_id` set.

## Timesheet Lines

Timesheets are stored in `account.analytic.line`:
- `task_id`: Links to the task
- `project_id`: Links to the project
- `employee_id`: Who logged the time
- `unit_amount`: Hours logged (decimal)
- `date`: Date of the work

## Gotchas

- `effective_hours` changes only when timesheet lines are created, modified, or deleted — it does not update in real time if you are polling.
- `stage_id.fold` is the standard signal for "closed" — do not assume any specific stage name like "Done" is present across all Odoo instances.
- A task without `project_id` is a private task (assigned directly to a user, not part of a project). These do not appear in project views.
