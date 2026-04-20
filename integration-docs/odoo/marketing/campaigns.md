---
title: "Email Marketing Campaigns"
description: "mailing.mailing states, mailing.trace status values, pre-computed ratio fields, and filtering best practices"
---

## Campaign States

`mailing.mailing` represents a mass email campaign:

```
draft → in_queue → sending → done
```

- `draft`: Being composed, not yet scheduled
- `in_queue`: Scheduled for sending (waiting for the mail queue to process)
- `sending`: Currently being sent in batches
- `done`: Fully sent

Campaigns can also be `cancelled` from any pre-send state.

## Key Fields

- `subject`: Email subject line
- `email_from`: Sender address
- `contact_list_ids`: Mailing lists targeted (many2many to `mailing.contact.list`)
- `sent_date`: Datetime when the campaign was dispatched
- `schedule_date`: Planned send date (for scheduled campaigns)

## Tracking via mailing.trace

Individual delivery and engagement records are stored in `mailing.trace`. Each record corresponds to one recipient of one campaign.

Key fields:
- `mass_mailing_id`: The parent campaign
- `res_id`: ID of the recipient record
- `model`: Model of the recipient (e.g., `"mailing.contact"`, `"res.partner"`)
- `trace_status`: Current delivery/engagement status

## trace_status Values

| value | Meaning |
|---|---|
| `outgoing` | In queue, not yet sent |
| `sent` | Successfully delivered to mail server |
| `open` | Email opened (pixel tracked) |
| `reply` | Recipient replied |
| `bounce` | Hard or soft bounce |
| `error` | Send error |
| `cancel` | Cancelled before sending |

## Pre-Computed Ratio Fields

Use the ratio fields directly on `mailing.mailing` — do not compute them manually from `mailing.trace`:

- `opened_ratio`: `opens / sent * 100`
- `replied_ratio`: `replies / sent * 100`
- `bounced_ratio`: `bounces / sent * 100`
- `clicks_ratio`: `clicks / sent * 100` (if click tracking enabled)

## Gotchas

- Always filter `mailing.trace` by `mass_mailing_id` — the table is high-volume and full-table queries are slow.
- `trace_status="open"` requires the email client to load images (pixel tracking) — open rates are always undercounted.
- A single recipient can have multiple `mailing.trace` records for the same campaign if they are on multiple contact lists that overlap.
