---
title: "Composing and Sending Emails"
description: "When to use email_draft vs email_send, how to reply to an email thread, single-recipient limitation, and plain-text-only constraint."
---

## draft vs. send — Choose Carefully

- **`email_draft`**: Saves the email as a draft in the user's mailbox. Nothing is sent. Use this whenever a human should review before sending.
- **`email_send`**: Sends immediately. **Irreversible.** Use only for autonomous operations where the user has explicitly delegated sending authority.

When in doubt, draft. Ask the user to confirm, then send.

## Single Recipient Only

`to` accepts exactly **one** email address. To reach multiple people, make separate `email_send` calls — one per recipient.

A comma-separated list like `"alice@example.com, bob@example.com"` will **fail**. There is no CC or BCC support.

## Plain Text Only

The `body` field is plain text. HTML markup is sent literally and appears as raw markup to the recipient:

- `<b>bold</b>` → recipient sees `<b>bold</b>`, not **bold**
- `<br>` → recipient sees `<br>`, not a line break

Use blank lines and spacing for formatting. Do not use HTML tags.

## Replying and Threading

To reply to an existing email, use the `replyTo` parameter with the Gmail message **`id`**.

This is the short alphanumeric Gmail message ID (e.g., `17a50f27b08d8ac3`) — **not** an RFC 2822 Message-ID like `<abc@mail.example.com>`.

Correct flow:
1. `email_list` or `email_search` → find the email, note its `id`
2. `email_read(id)` → read the full message
3. `email_send(to: "...", replyTo: id, body: "...")` → sends as a reply in the same thread

Gmail automatically threads the reply. Do not manually add "Re:" to the subject.
