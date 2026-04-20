---
title: "Email Plugin Limitations"
description: "What the email plugin cannot do: no CC/BCC, no attachments, no HTML, no thread IDs, and how to handle credential expiry errors."
---

## What the Plugin Cannot Do

**No CC/BCC**: Only a single `to` recipient per call. There is no workaround — inform the user if multi-recipient delivery is required.

**No attachments**: `email_read` returns only the plain text body. Attachments are not downloaded or accessible. If an email contains only an attachment with no text body, `body` returns an empty string.

**Unread status is read-only**: You can read the `unread` field on a message but cannot mark emails as read or unread.

**No thread/conversation ID**: There is no `threadId` field. To work around this:
- To **reply**, use the message `id` + `replyTo` (see composing guide).
- To **find all emails in a conversation**, search by subject: `email_search(query: "subject:\"Re: Invoice #123\"")`

## HTML Emails

If an email has only an HTML body (no plain-text alternative), `email_read` returns the raw HTML markup. Be prepared to handle `<p>`, `<div>`, `<br>`, and similar tags in the `body` field. Strip or ignore tags when summarizing or quoting content.

## Credential Expiry

If you receive a `401 Unauthorized` error or a message containing `"Failed to fetch credentials"`, the user's OAuth token has expired.

There is no automatic retry or token refresh. The user must re-authorize the email connection in **Pinchy Settings → Integrations**. Stop the current task, notify the user, and ask them to reconnect their email account.

## Rate Limits

Gmail allows approximately 500 API requests per minute. If you receive a rate limit error, pause and retry after a short delay. Do not loop rapidly — it will not help and may extend the backoff period.
