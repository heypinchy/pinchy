---
name: odoo-attach
description: Attach files (receipts, delivery notes, contracts, supporting documents) to Odoo records with odoo_attach_file using the _pinchy_ref token. Use whenever the user sends a document that belongs on an Odoo record. Explains the ref-flow contract so you pass a real _pinchy_ref instead of fabricating a "<model>,<id>" string.
---

# Attaching files to records

Every `odoo_create` response includes a `_pinchy_ref` field — an opaque token (starting with `pinchy_ref:v1:`) that identifies the new record. Pass that value **verbatim** as `odoo_attach_file.targetRef`.

The same `_pinchy_ref` field appears on every record returned by `odoo_read`, so you can attach files to existing records the same way: read the target record, grab its `_pinchy_ref`, pass it as `targetRef`.

Never construct ref strings yourself. Formats like `"account.move,37"`, `"37"`, or any other guess will be rejected. The token is encrypted — only the plugin can produce a valid one.

## When to use

When the user sends a file that belongs on a record — a receipt or invoice for a
bill, a delivery note or packing slip for a transfer, a signed contract
amendment or medical certificate for an HR record, a specification or design
asset for a task, a quality report for a manufacturing order, supporting
documents for an approval. Always confirm the target record with the user before
attaching.

Source documents attached to accounting and approval records are the audit trail
external auditors ask for — attaching before posting/approval eliminates the
most common audit query ("where is the receipt?").

## Files from Telegram

When a message shows `[media attached: /root/.openclaw/media/inbound/<name>]`, that file is also available in your uploads directory under the same name — pass `<name>` (or the full bracketed path) to `odoo_attach_file`. If a file is not in your uploads directory, say so honestly and ask the user to re-send it. Never invent or guess filenames.
