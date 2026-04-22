---
title: "Expense Reports"
description: "hr.expense vs. hr.expense.sheet, approval state machine, payment modes, and policy cap misconceptions"
---

## Two-Level Structure

Expenses are managed at two levels:

- **`hr.expense`**: A single expense item — one receipt, one amount, one category
- **`hr.expense.sheet`**: An expense report that groups multiple `hr.expense` records for approval and reimbursement

An employee creates individual expenses and then submits them grouped into a sheet.

## Key Fields on hr.expense

- `employee_id`: Who incurred the expense
- `product_id`: Expense category (e.g., Travel, Meals) — uses `product.product` as category
- `unit_amount`: Price per unit
- `quantity`: Number of units
- `total_amount`: Computed — `unit_amount * quantity`
- `date`: Date of the expense
- `payment_mode`: How it was paid

## Payment Modes

- `"own_account"`: Employee paid with personal funds — reimbursement is owed to the employee
- `"company_account"`: Paid with a company credit card or account — no reimbursement needed

## Expense Sheet State Machine

```
draft → submit → approve → post → done
                       ↓
                     cancel / refuse
```

- `draft`: Created, not submitted
- `submit`: Submitted for manager approval
- `approve`: Approved by manager
- `post`: Accounting journal entries created
- `done`: Reimbursement paid (for `own_account`) or reconciled (for `company_account`)

## Filtering Active Reports

Open/pending reports: filter `hr.expense.sheet` by `state` in `["submit", "approve"]`.
Awaiting payment: `state="post"` and `payment_mode="own_account"`.

## Gotchas

- `list_price` on the `product.product` used as expense category is Odoo's standard reference price — it does **not** represent a policy cap or spending limit unless explicitly configured via custom fields or overrides in the organization.
- `total_amount` is computed — do not write to it directly. Set `unit_amount` and `quantity`.
- An `hr.expense` cannot be submitted directly — it must be attached to an `hr.expense.sheet`. A sheet can contain expenses from multiple dates.
