---
title: "Transfers and Picking Types"
description: "stock.picking lifecycle, picking types (IN/OUT/INT), multi-step routes, and linking transfers to source documents"
---

## Picking Types

Every `stock.picking` has a `picking_type_id` that classifies the operation:

| Code | Name | Direction |
|---|---|---|
| `incoming` / `IN` | Receipts | Supplier → Warehouse |
| `outgoing` / `OUT` | Delivery Orders | Warehouse → Customer |
| `internal` / `INT` | Internal Transfers | Location → Location |

The `picking_type_id.code` field holds `"incoming"`, `"outgoing"`, or `"internal"`.

## State Machine

```
draft → waiting → confirmed → assigned → done
                                      ↓
                                   cancel
```

- `draft`: Not yet validated by the system
- `waiting`: Waiting for another operation (chained transfer)
- `confirmed`: Transfer created, stock not yet reserved
- `assigned`: Stock reserved (`state_ids` on move lines are `assigned`)
- `done`: Transfer completed — stock has moved
- `cancel`: Cancelled — no stock impact

## Multi-Step Routes

Odoo supports 1-step, 2-step, and 3-step routes per warehouse:

- **1-step**: One picking (e.g., Ship directly)
- **2-step (OUT)**: Pick → Ship (two separate `stock.picking` records)
- **3-step (OUT)**: Pick → Pack → Ship (three separate `stock.picking` records)

Linked pickings share the same `group_id` (`procurement.group`). Follow the chain via `move_ids.move_dest_ids`.

## Linking to Source Documents

- `origin`: Text field — stores the name of the source document (e.g., `"S00042"` for a sales order, `"P00017"` for a purchase order). Used for display and search; it is a plain string, not a relational field.
- `sale_id` / `purchase_id`: Direct many2one to the source SO/PO (available if the respective module is installed)

## Gotchas

- Filtering transfers by `origin` is a text search — it can match partial strings. Use `sale_id` or `purchase_id` for reliable relational filtering.
- In 3-step configurations, the customer-facing delivery order is the last picking in the chain — not the first one generated.
- `scheduled_date` is the planned date; `date_done` is when the transfer was actually validated.
