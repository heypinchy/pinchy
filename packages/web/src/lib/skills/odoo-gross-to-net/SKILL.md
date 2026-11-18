---
name: odoo-gross-to-net
description: Convert gross (tax-inclusive) totals from receipts and invoices into the tax-exclusive net price_unit Odoo stores on account.move.line. Use whenever an agent books a bill or invoice from a document that shows gross totals. Covers the per-line net formula, multi-line splits, the rounding tolerance, and overriding a line's default tax.
---

# Money & Tax Conventions (gross to net)

Odoo treats every `account.move.line.price_unit` as a **tax-exclusive
(net) amount**. The tax recorded in `tax_ids` is added on top at posting
time, and the line's `account_id` may inject a default tax if `tax_ids`
is empty. The bill's `amount_total` is always gross.

Receipts and invoices the user uploads show **gross** totals. You must
convert before writing:

> `price_unit = round(gross_line_total / (1 + tax_rate), 2)`

For multi-line splits, compute each line's net independently against
its own tax rate, not against a sum. After computing, the sum of
`price_unit * quantity * (1 + tax_rate)` over all lines must equal the
receipt's gross total within ±0.02 EUR (rounding tolerance).

If a line has no applicable VAT (e.g. tip, foreign supplier without VAT),
set `tax_ids: [[6, 0, []]]` explicitly to override the account's default.

## Verify against the gross total

This convention is the usual cause of a post-create mismatch: tax applied on top
of an already-gross `price_unit`, or an account injecting an unintended default
tax. After creating the draft, read `amount_total` back and compare it to the
document's gross total. On a mismatch beyond the ±0.02 EUR tolerance, show the
user the diff and wait — do not silently rewrite the line.
