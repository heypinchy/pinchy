---
title: "Attendance and Contracts"
description: "hr.attendance check-in/out, hr.contract states, active contract identification, and worked hours computation"
---

## Attendance Records

`hr.attendance` tracks when employees clock in and out:

- `employee_id`: The employee
- `check_in`: Datetime when the employee clocked in
- `check_out`: Datetime when the employee clocked out (null if currently clocked in)
- `worked_hours`: Computed duration — `check_out - check_in` in decimal hours

`worked_hours` is a computed field — it cannot be set manually and is null while the employee is still clocked in (no `check_out` yet).

## Querying Attendance

To get attendance for a date range, filter on `check_in` (not `check_out`) — an entry's date is anchored to when the shift started.

Employees currently clocked in: filter `check_out = false`.

## Employee Contracts

`hr.contract` defines the employment terms:

- `employee_id`: The employee
- `wage`: Gross monthly salary (always monthly, regardless of pay frequency)
- `date_start`: Contract start date
- `date_end`: Contract end date — `null` (or `false`) means indefinite/open-ended
- `state`: Contract status

## Contract States

```
draft (New) → open (Running) → close (Expired)
                           ↓
                         cancel
```

- `draft`: Not yet active
- `open`: Currently active contract
- `close`: Contract ended (reached `date_end` or manually closed)
- `cancel`: Cancelled before activation

## Active Contract Detection

Only `state="open"` contracts are active. An employee should have exactly one `state="open"` contract at a time, but this is not enforced by all Odoo configurations.

To find the current contract: filter `hr.contract` by `employee_id`, `state="open"`, and `date_start <= today`, and either `date_end = false` or `date_end >= today`.

## Gotchas

- `worked_hours` is null (not zero) while an employee is clocked in — a null `check_out` means the shift is ongoing.
- `wage` is always the monthly gross salary. For hourly employees, check `hr.contract.hourly_wage` or custom fields.
- An employee can have multiple contracts over time — filter by `state="open"` to find the current one, not just by `employee_id` alone.
