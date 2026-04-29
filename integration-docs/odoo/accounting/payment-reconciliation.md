---
title: "Payment Reconciliation"
description: "How Odoo reconciles payments with invoices — partial payments, reconciliation state, and payment_state transitions"
---

## How Reconciliation Works

When a payment is registered against an invoice, Odoo creates journal entries on both sides and reconciles the outstanding receivable/payable lines. Reconciliation links `account.move.line` entries on the same account (typically the receivable or payable account) so they offset each other.

The reconciliation itself is stored in `account.partial.reconcile`, which records which debit line is matched to which credit line and for how much.

## payment_state on account.move

The `payment_state` field on `account.move` is **fully computed** — never set it manually.

| payment_state | Meaning |
|---|---|
| `not_paid` | No payment registered |
| `in_payment` | Payment created but not yet reconciled with a bank statement |
| `paid` | Fully reconciled |
| `partial` | Partially reconciled — outstanding balance remains |
| `reversed` | The invoice was reversed via credit note |

## Partial Payments

When the payment amount is less than the invoice total:
- `payment_state` becomes `"partial"`
- `amount_residual` shows the remaining open amount
- The next payment reconciles against the remaining `amount_residual`

To check open invoices: filter `account.move` by `move_type="out_invoice"`, `state="posted"`, and `payment_state` in `["not_paid", "partial"]`.

## Common Patterns

- **Overpayment**: Creates a credit on the customer account — visible as a negative `amount_residual` or separate credit line
- **Write-off during reconciliation**: Odoo can post a small difference to a write-off account (configured in the reconciliation wizard)
- **Bank statement matching**: `account.bank.statement.line` is reconciled separately — `in_payment` transitions to `paid` only after the bank statement line is matched

## Gotchas

- `payment_state` is computed from journal entry reconciliation, not from `account.payment` records directly. A payment exists but an invoice can still show `not_paid` if reconciliation did not happen.
- Do not read `account.payment` to determine invoice payment status — always read `payment_state` on `account.move`.
- Reconciliation can be undone (`account.partial.reconcile` deleted), which resets `payment_state` to `not_paid` or `partial`.
