---
title: "Purchase Order Lifecycle"
description: "State machine for purchase.order — RFQ to confirmed PO, expected delivery dates, and warehouse connection"
---

## State Machine

```
draft (RFQ) → sent (RFQ Sent) → purchase (Purchase Order) → done → cancel
```

- `draft`: Request for Quotation — editable, no stock impact
- `sent`: RFQ sent to vendor, still editable
- `purchase`: Confirmed Purchase Order — triggers incoming stock picking and billing readiness
- `done`: Locked PO — fully received and/or billed (set automatically or manually)
- `cancel`: Cancelled — linked stock pickings are also cancelled

Only `state="purchase"` orders are confirmed. Filtering for active purchase orders should always include this check.

## Key Fields

- `partner_id`: The vendor
- `date_order`: When the PO was confirmed
- `date_planned`: Expected delivery date (set at order level; individual lines also have `date_planned`)
- `amount_total`: Total PO value including taxes
- `invoice_status`: `"nothing"`, `"to invoice"`, `"invoiced"` — mirrors the billing state

## Delivery Connection

Confirming a PO generates one or more `stock.picking` records (type `incoming`):
- `stock.picking.origin` = PO name (e.g., `"P00042"`)
- `stock.picking.purchase_id` = direct many2one to the `purchase.order`

To check receipt status: read linked pickings and their `state`. A PO can be partially received (`state="assigned"` with partial done quantities).

## Billing from a Purchase Order

Vendor bills (`account.move` with `move_type="in_invoice"`) are linked to the PO via `invoice_ids`. The `invoice_status` on the PO is computed from received quantities vs. billed quantities.

## Gotchas

- `state="sent"` does **not** mean the order is confirmed — it means the RFQ was emailed. Always check for `state="purchase"` for confirmed orders.
- `date_planned` on the PO header is a convenience field; the authoritative delivery date per product is on `purchase.order.line.date_planned`.
- Cancelling a PO in `state="purchase"` requires cancelling linked stock pickings first if they are already in `assigned` or `done` state.
