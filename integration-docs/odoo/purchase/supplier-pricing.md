---
title: "Supplier Pricing and Pricelist"
description: "product.supplierinfo structure, minimum quantities, lead times, multi-vendor selection, and template vs. variant targeting"
---

## Supplier Price Records

Vendor prices are stored in `product.supplierinfo`. Each record defines what one vendor charges for one product under specific conditions.

Key fields:
- `partner_id`: The vendor (`res.partner`)
- `product_tmpl_id`: The product template (preferred — applies to all variants)
- `product_id`: Optional specific variant (overrides template-level record)
- `price`: Unit price charged by the vendor
- `min_qty`: Minimum order quantity for this price to apply (0 = no minimum)
- `delay`: Lead time in days from order to delivery
- `currency_id`: The currency of the quoted price

## Multiple Vendors per Product

A product can have multiple `product.supplierinfo` records — one per vendor and/or per quantity tier. To find the correct vendor price:

1. Filter by `product_tmpl_id` (or `product_id` for variant-specific)
2. Filter by `min_qty <= ordered_qty`
3. Sort by `price` ascending or by `sequence` if vendor preference is configured

The `sequence` field on `product.supplierinfo` determines the preferred vendor order when Odoo auto-selects a vendor.

## Lead Time

`delay` (in days) feeds into Odoo's scheduler and reordering rules. The computed expected receipt date on a PO line is `date_order + delay`.

## Template vs. Variant

- `product_tmpl_id` set, `product_id` not set: Price applies to **all variants** of the template
- Both set: Price applies to the **specific variant only**

When reading supplier prices for a product variant, check both template-level and variant-level records and use the most specific match.

## Gotchas

- `product.supplierinfo` records with `product_id` set take precedence over those with only `product_tmpl_id` — always check both levels when resolving vendor price.
- `price` in `product.supplierinfo` is in the vendor's currency (`currency_id`), not necessarily the company's currency. Always check `currency_id` before comparing prices.
- A `product.supplierinfo` record with `min_qty=0` means the price applies regardless of quantity — it is the baseline price, not a free-of-charge condition.
