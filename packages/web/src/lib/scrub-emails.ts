/**
 * Defence-in-depth for free-text audit fields (e.g. `providerError` on
 * `chat.agent_error`). When an upstream provider validation error gets
 * echoed back — `"Invalid input: user@example.com is not …"` — we never
 * want the raw address to land in the append-only HMAC-signed audit
 * table: GDPR Art. 17 erasure on an HMAC-signed row is impossible by
 * design, so we substitute any email-shaped run with `<email-redacted>`.
 *
 * Distinct from `redactEmail`, which returns a structured
 * `{emailHash, emailPreview}` pair for fields where we KNOW an email
 * is identity data and may want to match it later. Here we operate on
 * opaque free text — the only goal is "don't store the raw address".
 *
 * The regex deliberately requires a TLD (`\.[A-Za-z]{2,}`) so social
 * `@handle` mentions in free text don't get mistaken for emails.
 *
 * This lives in its own module, not in `@/lib/audit`, because that module
 * imports `@/db` and therefore constructs a postgres pool the moment it is
 * evaluated. `scrubEmails` is a pure regex substitution wanted by callers
 * that have no business touching the database — `@/lib/log-capture` is the
 * first, and it is exactly the kind of leaf a Client Component might import
 * one day, which would drag the DB driver into the client bundle and fail
 * `next build` with a "module not found" that points at postgres instead of
 * at the real mistake. `@/lib/audit` re-exports it, so existing call sites
 * are unaffected.
 */
// Unicode-aware: \p{L} covers internationalized-domain (IDN) emails like
// user@münchen.de, and the bracket alternative covers IP-literal domains like
// user@[192.168.1.1] — both of which the old ASCII-only class let through into
// the HMAC-signed, un-redactable audit detail. The TLD-required branch is kept
// so a social `@handle` mention isn't mistaken for an email.
const EMAIL_LIKE_PATTERN = /[\p{L}\p{N}._%+-]+@(?:\[[^\]\s]+\]|[\p{L}\p{N}.-]+\.[\p{L}]{2,})/gu;

export function scrubEmails(text: string): string {
  return text.replace(EMAIL_LIKE_PATTERN, "<email-redacted>");
}
