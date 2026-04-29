---
title: "POS Sessions and Reconciliation"
description: "pos.session lifecycle, cash balance tracking, pos.order states, and when orders hit the accounting layer"
---

## POS Session Lifecycle

A POS session (`pos.session`) represents a single cashier shift or register opening:

```
opening_control → opened → closing_control → closed
```

- `opening_control`: Session opened, waiting for opening count confirmation
- `opened`: Active — orders can be processed
- `closing_control`: Cashier is counting cash and reconciling
- `closed`: Session finalized — accounting entries posted

## Cash Balance Fields

- `cash_register_balance_start`: Starting cash (entered at opening)
- `cash_register_balance_end_real`: Actual cash counted at closing
- `cash_register_difference`: Computed difference — `end_real - expected_end` (over/short)

## POS Order States

`pos.order` has its own state machine:

| state | Meaning |
|---|---|
| `draft` | Order in progress (open tab), not yet paid |
| `paid` | Payment received in POS — POS-internally complete |
| `done` | Session closed, accounting entries posted |
| `invoiced` | Customer invoice (`account.move`) created and linked |
| `cancel` | Order cancelled |

## Accounting Impact

POS orders only hit the accounting layer when:
- The session is closed (`state="closed"`) — batch posts all `paid` orders as `done`
- Or an invoice is explicitly created for the order — changes state to `invoiced`

**Only `state="done"` or `state="invoiced"` orders have accounting entries.** `state="paid"` orders exist only in the POS layer until session close.

## Linking Orders to Accounting

- `pos.order.account_move`: The `account.move` posted when the session closes (batch entry)
- For individually invoiced orders: `pos.order.invoice_id` → `account.move` with `move_type="out_invoice"`

## Gotchas

- `state="paid"` does not mean "posted to accounting" — it means the customer paid at the terminal. Accounting happens at session close.
- Never query POS revenue from `pos.order` with `state="draft"` — those are open tabs with no committed revenue.
- Multi-session POS setups have one `pos.session` per register per shift — aggregate across sessions for daily totals.
