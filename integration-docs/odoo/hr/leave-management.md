---
title: "Leave Management"
description: "hr.leave.allocation vs. hr.leave, approval state machine, leave balance calculation, and common pitfalls"
---

## Two Models, One Process

Leave management uses two separate models:

- **`hr.leave.allocation`**: Grants an employee a leave entitlement (e.g., 25 vacation days per year)
- **`hr.leave`**: An individual leave request made by an employee against their allocation

An allocation must exist and be approved before a leave request can be approved.

## Leave Allocation States

```
draft → confirm → validate1 → validate
                           ↓
                         refuse
```

- `draft`: Created but not yet submitted
- `confirm`: Submitted for approval
- `validate1`: First approval (if two-level approval is configured)
- `validate`: Fully approved — employee can now use these days
- `refuse`: Rejected

## Leave Request (hr.leave) States

```
draft → confirm → validate1 → validate
                           ↓
                         refuse
```

Same state machine as allocations. `validate` = approved and confirmed leave.

## Key Fields on hr.leave

- `employee_id`: The employee taking leave
- `holiday_status_id`: The leave type (vacation, sick leave, etc.)
- `date_from` / `date_to`: Leave period (datetime)
- `number_of_days`: Computed from date range and work schedule — never set manually
- `state`: Current approval state

## Checking Leave Balance

The remaining leave balance is not directly available as a single field on a record. It is computed as:

`balance = total allocation (validate) - approved leaves (validate)`

Query via `hr.leave.type` (also called `hr.holiday.status`) with employee context — the `virtual_remaining_leaves` field returns the computed balance.

## Gotchas

- `number_of_days` is computed from the date range and the employee's work schedule. Setting dates on a leave request does not automatically set `number_of_days` — it is calculated server-side.
- Refused allocations (`state="refuse"`) do not grant any entitlement — filter to `state="validate"` only when computing balances.
- Public holidays reduce the `number_of_days` automatically based on the employee's work calendar.
