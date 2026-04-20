---
title: "Pricing and Margins"
description: "list_price vs. standard_price, margin calculation, pricelist logic, and company-specific cost pitfalls"
---

## Price Fields on Products

Two core price fields exist on `product.template`:

- `list_price`: The default **sales price** — company-wide, shown in the product form as "Sales Price". This is what gets put on quotations before pricelist rules apply.
- `standard_price`: The **cost price** (also called "Cost" in the UI). Used for margin calculations and inventory valuation. **Company-specific**: each company in a multi-company setup stores its own value.

On `product.product` (variant level), `list_price` inherits from the template. `standard_price` is also accessible at the variant level.

## Margin Calculation

```
margin = list_price - standard_price
margin_percentage = (list_price - standard_price) / list_price * 100
```

On `sale.order.line`, the fields `margin` and `margin_percent` are available directly (computed). On the order level, `margin` and `margin_percent` aggregate across all lines.

## Pricelist Logic

`product.pricelist` applies rules that override `list_price` per customer, quantity tier, or date range. Pricelists are assigned to customers via `res.partner.property_product_pricelist`.

Pricelist rules (`product.pricelist.item`) can set prices as:
- Fixed price
- Discount on `list_price`
- Markup on `standard_price`

The actual unit price on a `sale.order.line` after pricelist application is stored in `price_unit`.

## Reading Effective Prices

To get the effective price for a customer: read `price_unit` on `sale.order.line`, not `list_price` — the pricelist may have already adjusted it.

To compute what a price would be without an order, use the `product.pricelist` `_compute_price_rule()` method or the `product.pricelist.item` rules directly.

## Gotchas

- `standard_price` is company-dependent. In a multi-company environment, reading it without setting the correct company context will return the wrong value.
- `list_price` does **not** include taxes — it is always tax-excluded regardless of tax configuration.
- Pricelist rules with `compute_price="discount"` store the discount in `percent_price`, not in `price_discount`.
