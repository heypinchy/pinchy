---
name: odoo-write
description: Create and update records in a connected Odoo instance with odoo_create / odoo_write, following the standard write discipline. Use whenever an agent has write access and needs to add or change data. Covers draft-first and confirm-before-write, duplicate checks, single-call creation with inline child lines, never guessing relation IDs, and verifying the record after create.
---

# Writing to Odoo

When an agent has write access, `odoo_create` and `odoo_write` change real
business data. This skill is the shared discipline every write follows. The
model-specific procedure (which fields, which states, which dedup keys) lives
in each agent's own persona; this skill is the invariant contract that sits
underneath all of them.

Use it together with [[odoo-read]] — you always read before you write.

## Never write without confirming first

Every `odoo_create` or `odoo_write` on business data is preceded by an explicit
confirmation step. After you have prepared the change, present a clean summary
to the user (the key fields, amounts, dates, partners, and what will happen) and
ask before writing. Only proceed on an unambiguous yes. This holds even for a
single-record edit.

Where a model has a **draft → posted/confirmed** lifecycle (invoices, orders,
transfers, manufacturing orders), create in **draft** first and never advance
the state in the same step you create the record. Draft records are reversible;
confirming/posting/validating usually is not.

## Duplicate-check before every create

Before creating a new record, `odoo_read` for an existing match first (partner
by name, invoice by partner + date + amount, task by name + project, transfer by
partner + date + type). If you find a likely duplicate, STOP and tell the user
instead of creating a second one. This guards against double-writing when a
previous create succeeded silently before a provider error.

## One create call per record — inline the child lines

Lines belong to their parent. Create the parent and its lines in a SINGLE
`odoo_create` call by passing the child records inline (e.g. `invoice_line_ids`,
`order_line`, `move_ids_without_package`) with Odoo's `[0, 0, {…}]` command
tuples. Never create the child records separately from a parent you also just
created — that pattern leaves half-finished records if a call fails between the
two steps.

## Never guess relation IDs

For any many2one / many2many field (partner, account, tax, product, stage,
location…), look the target up with `odoo_read` and use the returned reference.
Never invent a numeric id or a `_pinchy_ref`. If a lookup returns several
plausible matches, ask the user which one rather than guessing.

## Verify the record after you create it

Immediately after `odoo_create` returns, `odoo_read` the new record and compare
the meaningful totals/fields against the source the user gave you (the receipt,
the delivery note, the request). If they match within tolerance, continue to the
confirmation step. If they diverge, STOP — show the user the diff and wait for
guidance. Never silently rewrite a record to force a match.

## Bulk operations: per-record review, single write

When a change touches more than a few records, summarize each affected record to
the user (not just the count) and wait for confirmation. On yes, you may issue a
single `odoo_write` with the full id list for efficiency — but every record must
have been individually surfaced first.

## Action tools over raw state writes

Some transitions have dedicated action tools (e.g. confirming an order,
validating a transfer, marking an MO done, recording an approval). Prefer those
over writing `state` by hand — a raw state write skips Odoo's side effects
(deliveries, procurement, back-flushing, accounting) and leaves a broken record.
When an action tool reports that Odoo needs a follow-up decision (backorder,
consumption, second approval step), relay that to the user instead of retrying.
