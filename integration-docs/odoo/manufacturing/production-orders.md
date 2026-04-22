---
title: "Production Orders"
description: "mrp.production state machine, quantity tracking, component consumption, and when components get reserved"
---

## State Machine

```
draft → confirmed → progress → to_close → done
                                       ↓
                                    cancel
```

- `draft`: MO created but not confirmed
- `confirmed`: Confirmed — component reservation triggered
- `progress`: Production has started (`qty_producing > 0`)
- `to_close`: All production done, pending final validation
- `done`: Fully completed — stock has moved, accounting entries posted
- `cancel`: Cancelled — all stock moves reverted

## Quantity Fields

- `product_qty`: Target quantity to produce (set when creating the MO)
- `qty_producing`: Quantity currently being produced (set during production)
- `qty_produced`: Total quantity already produced in previous operations (Odoo 16 split production)

The MO is complete when `qty_producing + qty_produced >= product_qty`.

## Date Fields

- `date_planned_start`: Planned start date/time (scheduled)
- `date_planned_finished`: Planned finish date/time
- `date_start`: Actual start datetime — set when production begins
- `date_finished`: Actual finish datetime — set when `state` moves to `done`

## Component Consumption

Components are represented as `stock.move` records linked to the MO:

- `stock.move.raw_material_production_id`: Links the move to the production order as a component
- `stock.move.production_id`: Links the move as a finished product output

Component moves are in `state="confirmed"` (not yet reserved) until the MO is confirmed and stock is available. They move to `state="assigned"` once reserved.

## Gotchas

- Components are reserved (`state="assigned"`) only after MO confirmation — not at `draft` state.
- `qty_producing` can be set to less than `product_qty` to allow partial production tracking.
- Scrap moves (`stock.scrap`) generated during production are separate from the component moves and have their own location (`scrap location`).
