---
title: "Sales Order Lifecycle"
description: "State machine for sale.order — from quotation draft to confirmed order, locking, and cancellation"
---

## State Machine

```
draft (Quotation) → sent (Quotation Sent) → sale (Sales Order) → done (Locked)
                                                              ↓
                                                           cancel
```

- `draft`: Editable quotation, no stock impact, no accounting impact
- `sent`: Quotation emailed to customer, still editable
- `sale`: Confirmed sales order — triggers stock moves and invoice readiness
- `done`: Locked order — no further edits allowed (set manually or via setting)
- `cancel`: Cancelled — stock moves are cancelled, no accounting entries created

## Confirming and Cancelling

To confirm: call the `action_confirm` method or write `state="sale"` (triggers the same logic via ORM). Confirmation generates delivery orders (`stock.picking`) and makes the order invoiceable.

To cancel a confirmed order (`state="sale"`): **never delete it**. Call `action_cancel` instead. This cancels linked stock moves and preserves the audit trail.

Deletion is only safe for `state="draft"` or `state="cancel"` orders.

## Invoicing from a Sales Order

- `invoice_status`: `"nothing"` → `"to invoice"` → `"invoiced"` (computed from delivered/ordered quantities)
- Invoices are created via `_create_invoices()` — do not create `account.move` manually from a SO
- Multiple invoices per order are possible (partial deliveries)

## Refunds vs. Cancellation

- **Cancel** (`state → cancel`): Before or immediately after confirmation, no goods delivered
- **Credit note** (`out_refund`): After delivery/invoicing — create a credit note on the invoice, not a SO cancellation

## Gotchas

- `state="done"` (locked) is different from `state="cancel"`. Locked orders are fulfilled and closed, not cancelled.
- Deleting a sales order in `state="sale"` or `state="done"` will raise an error — always cancel first.
- `commitment_date` is the promised delivery date to the customer; `date_order` is when the order was placed.
