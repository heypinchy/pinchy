---
title: "eCommerce Orders"
description: "Online orders as sale.order with website_id, abandoned cart detection, visitor tracking, and filtering online vs. offline orders"
---

## Online Orders are sale.order Records

Odoo eCommerce does not use a separate order model. Online orders are standard `sale.order` records with `website_id` set to the website they originated from.

To distinguish online from offline orders:
- **Online**: `website_id != false`
- **Offline** (manual, phone, POS-linked): `website_id = false`

Always apply this filter when querying eCommerce-specific data to avoid mixing channels.

## Order States in eCommerce Context

The standard `sale.order.state` values apply, but have specific meanings in the eCommerce flow:

| state | eCommerce meaning |
|---|---|
| `draft` | Active or abandoned cart — customer browsing/in-progress |
| `sent` | Quotation sent (rare in eCommerce, usually skipped) |
| `sale` | Confirmed online order — payment received |
| `cancel` | Order cancelled (by customer or admin) |

## Abandoned Carts

Carts older than 7 days in `state="draft"` are considered abandoned by Odoo's built-in abandoned cart recovery feature. To query them:

```
[("website_id", "!=", false), ("state", "=", "draft"), ("date_order", "<", <7_days_ago>)]
```

The threshold may vary if the abandoned cart recovery settings are customized.

## Website Visitors

`website.visitor` tracks both anonymous and authenticated visitors:

- `partner_id`: Set after the visitor logs in or completes checkout — null for anonymous visitors
- `name`: Display name (anonymous or partner name)
- `access_token`: Unique token identifying the anonymous visitor session
- `last_connection_datetime`: Most recent visit

Visitor records link to orders via `partner_id` (after login) or session cookies (anonymous, handled internally).

## Key eCommerce Fields on sale.order

- `website_id`: Which website the order came from
- `cart_quantity`: Total item count in the cart (computed)
- `website_order_line`: Visible order lines (excludes internal/delivery lines)

## Gotchas

- `state="draft"` orders with `website_id` set include **both** active carts and abandoned carts — filter by `date_order` to separate them.
- Orders created via the backend (manual SO) have `website_id=false` even if the company runs an eCommerce site — they are not eCommerce orders.
- `website.visitor.partner_id` is only set after authentication. Anonymous visitor data is tied to the session token, not a partner record.
