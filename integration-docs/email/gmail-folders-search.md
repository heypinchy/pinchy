---
title: "Gmail Folders and Search Syntax"
description: "Gmail folder names (labels), search query syntax with examples, and how to filter by date, sender, and read status."
---

## Gmail Folder Names (Labels)

Gmail uses label IDs, not display names. The built-in system labels are all uppercase:

- `INBOX` — primary inbox
- `SENT` — sent messages
- `DRAFTS` — unsent drafts
- `SPAM` — spam folder
- `TRASH` — deleted messages

Do NOT use `"Sent Items"`, `"Sent Mail"`, or any lowercase variants — they will return no results or an error.

Custom labels use their exact display name, e.g. `"Important"` or `"Follow Up"`.

The default folder for `email_list` is `INBOX` if the parameter is omitted.

## Search Query Syntax

Gmail uses its own query syntax. Multiple criteria are ANDed implicitly (no keyword needed).

- `from:alice@example.com` — from sender
- `to:bob@example.com` — to recipient
- `subject:"quarterly report"` — phrase in subject (**quotes required for multi-word phrases**)
- `is:unread` / `is:starred` — read status or starring
- `newer_than:7d` — last N days/hours/months/years (`1h`, `3m`, `2y`)
- `after:2026/04/01` / `before:2026/04/20` — explicit date range
- `has:attachment` — has attachments

Example: `from:alice@example.com is:unread newer_than:7d`

## Gotchas

- `is:unread` is NOT a folder. Do not pass it as the `folder` parameter — it will fail.
  Use `unreadOnly: true` in `email_list`, or include `is:unread` in an `email_search` query.
- `unreadOnly: true` in `email_list` is equivalent to adding `is:unread` to a search query. Don't use both.
- Subject phrase queries without quotes (`subject:quarterly report`) match only the first word.
