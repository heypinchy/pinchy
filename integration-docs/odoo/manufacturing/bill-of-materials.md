---
title: "Bill of Materials"
description: "mrp.bom types (normal, phantom, subcontract), component lines, multi-BOM per product, and phantom BOM behavior"
---

## BOM Types

`mrp.bom.type` determines how the BOM behaves:

| type | Name | Behavior |
|---|---|---|
| `normal` | Manufacture | Creates a Manufacturing Order. Standard production. |
| `phantom` | Kit | No Manufacturing Order — components are consumed directly on sale/delivery. |
| `subcontract` | Subcontracting | Sends components to a subcontractor, receives finished goods. |

## BOM Structure

- `product_tmpl_id`: The finished product (template level)
- `product_id`: Optional — restricts the BOM to a specific variant
- `product_qty`: How many units of the finished product this BOM produces (default: 1)
- `bom_line_ids`: Component lines (`mrp.bom.line`)

Each `mrp.bom.line` has:
- `product_id`: The component product
- `product_qty`: Quantity needed per `mrp.bom.product_qty` of finished product
- `product_uom_id`: Unit of measure

## Multiple BOMs per Product

A product can have multiple BOMs. Odoo selects the BOM to use based on:
1. Variant match (`product_id` on BOM matches the variant being produced)
2. Lowest `sequence`

If multiple BOMs match, the one with the lowest sequence wins. This allows BOMs for specific variants alongside a default template-level BOM.

## Phantom (Kit) BOMs

Phantom BOMs do not generate Manufacturing Orders. When a kit product is sold or delivered:
- The kit's `stock.move` is exploded into component moves automatically
- Components are picked directly from stock
- The finished product (kit) itself never enters stock

## Gotchas

- Phantom BOMs are transparent to customers — the invoice shows the kit product, but the delivery picks individual components.
- If a product has both a `normal` and a `phantom` BOM, the `type` determines which process applies — check `type` explicitly, not just BOM existence.
- `product_qty` on the BOM is the output quantity, not a multiplier. A BOM with `product_qty=2` produces 2 units per production run — halve component quantities if you need 1 unit.
