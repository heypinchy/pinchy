---
title: "VAT Booking Best Practices"
description: "How to correctly handle VAT in Odoo — tax-included vs. tax-excluded pricing, tax groups, and common pitfalls"
---

## Tax Configuration in Odoo

Odoo handles VAT through `account.tax` records. Each tax has:
- **Type**: Percentage or fixed amount
- **Tax Scope**: Sales, purchases, or both
- **Tax Group** (`account.tax.group`): Groups related taxes for reporting (e.g., "VAT 20%", "VAT 10%")
- **Included in Price**: Whether the tax is already included in the product price

### When to use tax-included vs. tax-excluded

- **B2B (business-to-business)**: Use **tax-excluded** prices. Businesses care about net prices and reclaim VAT.
- **B2C (business-to-consumer)**: Use **tax-included** prices. Consumers see final prices.

Set this on the product's `taxes_id` field (default sales tax) and `supplier_taxes_id` (default purchase tax).

## Correct Booking Flow

1. **Never manually compute tax amounts**. Always use Odoo's tax engine — set the tax on the invoice line via `tax_ids`, and Odoo computes the amounts.
2. **Use `account.move` with `move_type: "out_invoice"`** for customer invoices. The tax lines (`account.move.line` with `tax_line_id` set) are auto-generated.
3. **Don't create tax journal entries manually**. Odoo creates them automatically when posting the invoice.

## Reading Tax Data via API

To check which taxes are applied:
- Read `account.move.line` with `tax_ids` (many2many to `account.tax`) for the line-level taxes
- Read `account.move.line` where `tax_line_id` is set for the computed tax amounts
- The `tax_base_amount` field on tax lines shows the base amount the tax was computed from

## Common Mistakes

- **Don't set `amount_tax` manually** on `account.move`. It's a computed field.
- **Don't create `account.move.line` entries for taxes**. Post the invoice and Odoo creates them.
- **Mixing tax-included and tax-excluded** on the same invoice causes confusion. Pick one per pricelist.
