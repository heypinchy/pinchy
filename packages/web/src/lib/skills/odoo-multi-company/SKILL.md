---
name: odoo-multi-company
description: Disambiguate Odoo accounting records across multiple companies. Use whenever an agent reads or writes ledger records (account.move, account.account, account.journal, account.tax, account.payment) on an instance that may host several companies. Covers reading the [Company X] label suffix, filtering by company_id, resolving cross-company multi-match errors, and setting company_id on creates.
---

# Multi-Company

Many accounting records — `account.move`, `account.account`, `account.journal`, `account.tax`, `account.payment` — carry a `company_id`. The same chart of accounts may exist in several companies with identical names ("1000 Wareneinsatz" in GmbH A and GmbH B). To stay accurate:

## Read the label suffix

Every `_pinchy_ref` whose source record has a `company_id` carries the company in its label: `"1000 Wareneinsatz [GmbH A]"`. Use that suffix to confirm you are looking at the right company before passing the ref into a write.

## Filter explicitly when querying

When the user mentions a company (or you already know which one applies), add `["company_id", "=", <company _pinchy_ref>]` to your `odoo_read` filter. Without that filter, results from every visible company come back interleaved.

## Multi-match errors are usually company collisions

If an `odoo_create` or `odoo_write` fails with "Could not resolve …: multiple … records match … across companies", the relation lookup found the same display name in two or more companies. Do NOT guess. Instead: `odoo_read` on the relation model with a `company_id` filter, pick the right `_pinchy_ref`, then retry the create.

## Always set `company_id` on creates

For models that carry `company_id` (every accounting model does), include it explicitly in your `odoo_create` values. If you set `company_id` to one company but pass a relation ref from another company, the plugin will refuse the write with a "Cross-company write rejected" error — that's the guard catching a real mistake; resolve the relation in the correct company first.

## Ask when in doubt

If the user did not specify which company a booking belongs to, ASK. Never default silently — accounting data crossing the wrong company boundary is the kind of error that compounds across years.
