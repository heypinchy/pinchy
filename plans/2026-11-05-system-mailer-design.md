# System mailer (SMTP) for invitations and password resets — design

Issue: heypinchy/pinchy#1309. Related, in flight elsewhere: #1307 (Copy link as the
primary action in the invite dialog) and #1265 (invite dialog copy: "Pinchy
doesn't send email", expiry).

## Problem

An admin creating an invite or a password reset gets a link and has to hand it
to the person by some other channel. The first enterprise customer will invite
about 30 people that way. Every comparable product sends the invitation itself
and keeps the link as a fallback.

Pinchy is offline-first and self-hosted. Agent mailboxes (`pinchy-email`) are
integrations that belong to agents, not a system mailer, so there is nothing to
reuse at the product level. The feature has to be **optional** and **off by
default**, and the copy-link path has to keep working in every case, including
a configured mailer that fails.

## Decisions

### 1. Storage — one encrypted setting

The whole configuration is one JSON value in the existing `settings` table under
the key `system_mail`, stored with `encrypted = true` (`setSetting(key, value,
true)`, AES-256-GCM via `lib/encryption.ts`). One row, because the password is
meaningless without the host it belongs to, and a partially written config is a
state no reader should have to handle.

```ts
type SystemMailConfig = {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username?: string; // absent → no AUTH (internal relays)
  password?: string;
  fromAddress: string;
  fromName?: string; // display name, defaults to "Pinchy"
};
```

No row means "off". There is no separate `enabled` flag: a flag next to a
complete config is a second way to say the same thing, and the two can disagree.
Turning it off deletes the row.

This is Pattern-B-adjacent in spirit (Pinchy itself is the only consumer), so
the credential never reaches `openclaw.json` or any plugin config.

### 2. API

All admin-only (`requireAdmin`), schemas in `lib/schemas/system-mail.ts`, shared
with the UI and parsed with `parseRequestBody`.

| Route                            | Purpose                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/settings/mail`         | `{ configured: false }` or the config **without** the password plus `hasPassword`. |
| `PUT /api/settings/mail`         | Verify the connection, then save. An omitted `password` keeps the stored one.      |
| `DELETE /api/settings/mail`      | Turn the mailer off.                                                               |
| `POST /api/settings/mail/test`   | Send a test email to the signed-in admin's own address using the **saved** config. |
| `POST /api/users/invite`         | Gains `sendEmail?: boolean`. Response gains `emailDelivery`.                       |
| `POST /api/users/[userId]/reset` | Gains an optional body `{ sendEmail?: boolean }`. Response gains `emailDelivery`.  |

`emailDelivery` is `{ sent: true }` or `{ sent: false, error: string }`, and is
absent when no email was asked for.

**Verify before save** (designing-pinchy-features, pattern 5): `PUT` runs
nodemailer's `verify()` (connect, STARTTLS/TLS, AUTH) before persisting. A
failure is a 400 with the classified, actionable message from
`classifyProbeError` (shared with the IMAP connect flow), and nothing is stored.
The test button is the second half: `verify()` proves the server accepts us; a
delivered test email proves the sender address is accepted too, which relays
reject far more often than they reject a login.

**SSRF**: the host goes through `assertMailHostAllowed` — same guard and same
`ALLOW_PRIVATE_MAIL_HOSTS=1` opt-in as the IMAP integration. An on-premise relay
on a private range is a legitimate setup and the opt-in is the operator saying so.

### 3. Audit

- `settings.updated` with `resource: "settings:mail"` and a `changes` diff of
  the non-secret fields (`host`, `port`, `security`, `username`, `fromAddress`,
  `fromName`). The password appears only as `passwordChanged: true`. `DELETE`
  writes the same event with every field going to `null`, like the domain lock.
- A failed verify on `PUT` writes `settings.updated` with `outcome: "failure"`
  and the classified error, so a probe against an internal host leaves a trace.
- **New event `mail.sent`**, one row per attempted send, `outcome`
  success/failure. Detail: `purpose` (`"invite" | "password_reset" | "test"`),
  the recipient via `redactEmail()`, the invite id for invite/reset, and the
  error message on failure. Sending an email to a person is an outbound side
  effect and the one thing an auditor asks about afterwards ("did the reset
  link go out, and to whom?").

`user.invited` stays as is; the `mail.sent` row beside it answers whether the
invitation was also emailed.

### 4. The link origin

Today the link is built in the browser from `window.location.origin`
(`lib/invite-url.ts`, #352). An email is built on the server, so the server
needs an origin:

1. The locked domain (Settings → Security), as `https://<domain>`, when set.
2. Otherwise the request's forwarded origin (`resolveForwardedOrigin`, the same
   reading the OAuth routes use) — the host the admin is browsing, which is what
   the copy-link path uses too.

The locked domain wins because it is the one value an admin configured on
purpose, and because it makes the link independent of `X-Forwarded-Host`.

### 5. The email

Plain text plus a simple HTML alternative, no images, no tracking, no remote
assets. Voice per PERSONALITY.md: direct, warm, no exclamation marks. It names
who invited them, where (the instance host — Pinchy has no organisation name
setting, and the host is what the recipient will see in the browser), the
expiry date, and that the link works once.

> Subject: Clemens invited you to Pinchy
>
> Hi,
>
> Clemens (clemens@example.com) invited you to Pinchy at pinchy.example.com.
>
> Set your password and sign in here:
> https://pinchy.example.com/invite/…
>
> The link works once and expires on 12 November 2026. If you weren't expecting
> this, you can ignore this email.

The reset email is the same shape ("Clemens created a password reset link for
your Pinchy account …"). Names and addresses are header-safe: the subject is
built from the inviter's display name with CR/LF stripped, and the HTML body
escapes every interpolated value.

### 6. Failure handling — the invite is never lost

The invite (or reset token) is created first, in its own transaction, exactly as
today. Only then is the email attempted, bounded by connection/greeting/socket
timeouts (10s/10s/20s). Whatever happens to the send, the route answers `201`
with the token. A failed send is reported in `emailDelivery.error` and the UI
shows the link with an inline error ("We couldn't send the email: … Copy the
link below and send it yourself."). The admin never has to recreate an invite
because SMTP hiccupped.

### 7. UI

**Settings → Organization → Email delivery** (a card, not a new tab: it is one
organisation-wide setting, and Organization already holds the others).

- Off (default): one sentence ("Pinchy doesn't send email. Invite and reset
  links are shown for you to copy.") and a **Set up email** button.
- Form fields shown: SMTP server, sender address, username, password. Port and
  encryption are derived (587 + STARTTLS) and shown as a one-line summary with
  **Change** (progressive disclosure; picking port 465 switches the default
  encryption to TLS unless the admin already touched it). The username is
  prefilled from the sender address until touched. Sender name is optional
  and also lives behind **Change**.
- **Save** verifies first; failure is inline in the form.
- Configured: summary (`smtp.example.com:587 · STARTTLS · from pinchy@example.com`),
  **Send test email** (to your own address, result as a toast), **Edit**,
  **Turn off**.

Field count (R/S/D): required = host, port, security, fromAddress (4); derived =
port, security (2); shown = host, fromAddress, username, password (4, two of
them optional because relays without AUTH exist). Username is prefilled, so the
common case is three typed fields.

**Invite dialog.** The dialog asks `GET /api/settings/mail` when it opens.

- Mailer configured: the submit button reads **Send invitation**. After submit:
  "Invitation sent to anna@example.com." plus the link with Copy, so the
  fallback is always there. On a send failure: the link, Copy, and the inline
  error.
- Not configured: unchanged (**Create Invite** → link). The "Pinchy doesn't send
  email" sentence is #1265's; this change does not add or move it.

To stay out of #1307's way the change is additive: the result view gets a status
line above the existing link block, and the submit label switches. Whoever lands
second merges a one-line conflict at most.

**User detail sheet (reset).** Same rule: with a mailer, the button reads
**Email reset link** and the result shows "Reset link sent to …" plus the link.

### 8. Offline-first

Off by default, nothing in the install or upgrade path changes, no new
environment variable, no new container. With no `system_mail` row every code
path is byte-for-byte today's behaviour (the invite route never even loads
nodemailer — it is imported lazily inside the sender).

## Testing

- Unit: schema, config storage (round trip, password kept on omit), transport
  options per security mode, origin resolution, template (escaping, header
  injection, expiry), sender (success, failure classified, never throws past the
  route).
- Route: `GET/PUT/DELETE /api/settings/mail` incl. audit payloads and "no
  password in the response"; `/test`; invite and reset with `sendEmail` true,
  false, configured and not, and a failing send still returning 201 + token.
- Components: invite dialog label and result states; settings card.
- E2E (`playwright.imap.config.ts`, GreenMail already in that stack): configure
  the mailer against `greenmail:3025`, send an invitation from the dialog, read
  the delivered message from GreenMail over IMAP, open the link from the email
  body and claim the account. Plus: a mailer pointing at a dead port still shows
  the link.

## Not in scope

- An organisation-name setting (the email names the host instead).
- Custom templates, localisation of the email (the app is English).
- Self-signed certificates on internal relays (`rejectUnauthorized: false`).
  A relay with a private CA needs `NODE_EXTRA_CA_CERTS`, documented.
- Sending other system notifications (budgets, approvals) by email. The mailer
  is a building block for that; wiring it is a separate decision.
- Bulk invite (CSV). 30 invites with the dialog are 30 submits; a bulk path is
  its own feature.
