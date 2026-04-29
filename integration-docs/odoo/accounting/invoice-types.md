---
title: "Invoice Types and Credit Notes"
description: "When to use out_invoice, in_invoice, out_refund, in_refund — and how to create credit notes correctly"
---

## Invoice Types in Odoo

Odoo uses `account.move` for all accounting entries. The `move_type` field determines the type:

| move_type | Name | Direction | Use case |
|-----------|------|-----------|----------|
| `out_invoice` | Customer Invoice | You → Customer | Billing for goods/services sold |
| `in_invoice` | Vendor Bill | Vendor → You | Recording a purchase |
| `out_refund` | Credit Note | You → Customer | Correcting/cancelling an invoice |
| `in_refund` | Vendor Credit Note | Vendor → You | Vendor corrects a bill |
| `entry` | Journal Entry | Internal | Manual adjustments, reclassifications |

## Creating Credit Notes

**Always create credit notes via refund, not manual journal entries.**

The correct way:
1. Find the original invoice (`out_invoice`, state `posted`)
2. Create an `out_refund` with `reversed_entry_id` pointing to the original
3. The credit note inherits the partner, taxes, and account assignments

**Never** create a negative `out_invoice`. Odoo's tax reporting, payment reconciliation, and aged receivables all depend on the correct `move_type`.

## Partial Credit Notes

To credit part of an invoice:
1. Create an `out_refund`
2. Only include the lines being credited (with correct quantities/amounts)
3. Odoo handles the accounting entries automatically

## Draft vs. Posted

- `state: "draft"` — editable, no accounting impact
- `state: "posted"` — final, creates journal entries, visible in reports
- **Never delete a posted invoice**. Create a credit note instead.
