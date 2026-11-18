---
name: odoo-lot-serial
description: Record lot and serial numbers correctly on Odoo stock moves for tracked products. Use whenever a warehouse or production agent picks, receives, transfers, or produces goods. Explains that products with tracking="lot" or "serial" need the actual lot/serial on each stock.move.line and that you must never invent one.
---

# Lot & serial discipline

Products carry a `tracking` field: `"none"`, `"lot"`, or `"serial"`. For any
product with `tracking="lot"` or `tracking="serial"`, Odoo requires the actual
lot or serial number on each `stock.move.line` — on the picked/received
components and on the produced finished good.

- **Never guess or invent a lot/serial.** If the user hasn't given you the lot
  or serial for a tracked product, ASK. A blank or fabricated lot corrupts
  traceability and blocks validation.
- Record the lot/serial on the relevant `stock.move.line` (`lot_id` / lot name)
  **before** validating a picking or marking a manufacturing order done. Once the
  move is processed, correcting the lot means reversing physical stock.
- Serial-tracked products need one distinct serial per unit; lot-tracked products
  share a lot across a quantity. Check the product's `tracking` value with
  `odoo_describe_model` / `odoo_read` when unsure which applies.

When you cannot complete a tracked move because a lot/serial is missing, stop and
tell the user exactly which product needs which number — do not validate a
partial or blank move to get past it.
