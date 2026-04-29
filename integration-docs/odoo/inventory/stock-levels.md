---
title: "Stock Levels and Quants"
description: "How Odoo tracks current inventory — stock.quant vs. stock.move, location types, and filtering for real stock"
---

## Two Ways to Read Stock

Odoo has two related but different models for stock data:

- **`stock.quant`**: Current on-hand quantity at a specific location. This is the live inventory snapshot.
- **`stock.move`**: A movement record — describes a transfer of quantity from one location to another. Historical and in-progress movements.

Use `stock.quant` to answer "how much do we have?" and `stock.move` to answer "what moved and when?"

## Key Fields on stock.quant

- `product_id`: The product
- `location_id`: Where the stock physically is
- `quantity`: Total quantity on hand at this location
- `reserved_quantity`: Quantity reserved for pending outgoing transfers
- `available_quantity`: `quantity - reserved_quantity` — what can actually be picked (computed)

## Location Types

The `location_id.usage` field classifies locations:

| usage | Meaning |
|---|---|
| `internal` | Actual warehouse storage — counts toward real stock |
| `customer` | Goods delivered to customer (virtual) |
| `supplier` | Goods received from supplier (virtual) |
| `inventory` | Inventory adjustment source/destination |
| `production` | Manufacturing consumption/output |
| `transit` | In-transit between companies |
| `view` | Structural parent, no stock stored here |

## Filtering for Real Stock

Always filter `stock.quant` by `location_id.usage = "internal"` to get actual warehouse stock. Without this filter, results include customer and supplier virtual locations.

## Key Fields on stock.move

- `state`: `draft`, `waiting`, `confirmed`, `assigned`, `done`, `cancel`
- `product_uom_qty`: Planned quantity to move
- `quantity_done` (Odoo 16) / `quantity` (Odoo 17+): Actual quantity moved
- `location_id` / `location_dest_id`: From → To

## Gotchas

- `stock.quant` with `quantity=0` records are normal — they represent a location where stock has been but is now empty.
- Never sum `stock.quant.quantity` without filtering `location_id.usage = "internal"` — virtual locations inflate the numbers.
- `available_quantity` can be negative if reservations exceed on-hand quantity (e.g., negative stock allowed in settings).
