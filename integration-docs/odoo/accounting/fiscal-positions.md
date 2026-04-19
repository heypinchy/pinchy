---
title: "Fiscal Positions"
description: "How Odoo maps taxes and accounts for different customer types and regions — EU cross-border, tax-exempt, reverse charge"
---

## What Fiscal Positions Do

A fiscal position (`account.fiscal.position`) automatically **maps taxes and accounts** when creating invoices for specific customer types or regions. Instead of manually changing taxes per invoice, you assign a fiscal position to the customer.

Example mappings:
- **EU reverse charge**: Maps "VAT 20% (Sales)" → "VAT 0% (EU Reverse Charge)"
- **Tax-exempt customer**: Maps "VAT 20% (Sales)" → no tax
- **Different country**: Maps domestic tax → export tax rate

## Key Fields

- `account.fiscal.position`:
  - `name`: e.g., "EU B2B (Reverse Charge)"
  - `auto_apply`: If true, Odoo selects this position automatically based on country/VAT
  - `country_id` / `country_group_id`: Triggers auto-apply
  - `vat_required`: Customer must have a VAT number for this position to apply
  - `tax_ids`: Tax mapping rules (from → to)
  - `account_ids`: Account mapping rules (from → to)

## Best Practices

1. **Set fiscal positions on the customer (`res.partner.property_account_position_id`)**, not on individual invoices
2. **Use `auto_apply: true`** with country and VAT rules for automatic assignment
3. **For reading/analysis**: Check `partner.property_account_position_id` to understand which tax rules apply to a customer
4. **Don't modify taxes on invoice lines manually** when a fiscal position should handle it — fix the fiscal position mapping instead
