// A stored secret is bound to the destination it was entered for.
//
// Pinchy never shows a saved API key or password again, so an edit form offers
// "leave blank to keep the current one". That convenience must not extend to
// WHERE the secret goes: if an update could move the destination and keep the
// stored secret, an admin — or a stolen admin session — could point a provider
// or an integration at a host they control and receive the secret on the next
// probe or request. No SSRF guard helps; the attacker's host is public.
//
// So every write path that reuses a stored secret asks this module first: does
// the update change the destination? If it does, the caller demands the secret
// in the same request and refuses (422, field error on the secret) otherwise.
// Both the server routes and the client forms import it, so it stays
// import-free and client-safe.

/** Reason recorded on the failure audit row of a refused update. */
export const SECRET_REQUIRED_FOR_NEW_DESTINATION = "secret_required_for_new_destination";

/** One destination field that differs, in audit-safe form. */
export type DestinationChanges = Record<string, { from: string | number; to: string | number }>;

/**
 * The form of a URL a secret is bound to: scheme, lowercased host, port (the
 * default one dropped), path and query. Only a trailing slash is ignored. The
 * path counts because a shared origin can route by path — a Cloudflare AI
 * Gateway URL `/v1/<account>/<gateway>` sends the key into whichever account it
 * names. `null` when the URL does not parse.
 */
export function canonicalDestinationUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * The same URL as it may appear in an audit row: origin and path only. Userinfo
 * and the query are dropped because either can carry a credential.
 */
export function auditableDestinationUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * `{ from, to }` (audit-safe) when the submitted base URL is a different
 * destination than the stored one, otherwise `null`. An unreadable stored URL
 * counts as changed — the safe side.
 */
export function baseUrlDestinationChange(
  storedUrl: string,
  nextUrl: string
): { from: string; to: string } | null {
  const stored = canonicalDestinationUrl(storedUrl);
  if (stored !== null && stored === canonicalDestinationUrl(nextUrl)) return null;
  return { from: auditableDestinationUrl(storedUrl), to: auditableDestinationUrl(nextUrl) };
}

/** Upper bound, in UTF-8 bytes, for one destination value in an audit row. */
export const AUDIT_DESTINATION_MAX_BYTES = 256;

/**
 * A destination value as it may appear in an audit row: at most
 * {@link AUDIT_DESTINATION_MAX_BYTES} bytes, ending in "…" when cut. The caller
 * picks the destination, so it picks its length too, and an audit detail over
 * 2 KB is replaced wholesale by a truncation summary — `reason` and the
 * destination diff would go with it and stop being filterable. Cut on
 * character boundaries; scrub PII from the value BEFORE capping it, so a cut
 * can never leave half an address the scrubber no longer recognizes.
 */
export function capForAudit(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= AUDIT_DESTINATION_MAX_BYTES) return value;
  const budget = AUDIT_DESTINATION_MAX_BYTES - encoder.encode("…").length;
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

type FieldRule = {
  /** Compare form; equal forms mean "same destination". */
  normalize: (value: unknown) => string;
  /** What the audit row shows. */
  audit: (value: unknown) => string | number;
};

const text = (value: unknown) => String(value ?? "").trim();
const hostRule: FieldRule = {
  normalize: (v) => text(v).toLowerCase(),
  audit: (v) => text(v).toLowerCase(),
};
const portRule: FieldRule = {
  normalize: (v) => String(Number(v)),
  audit: (v) => Number(v),
};
const exactRule: FieldRule = { normalize: text, audit: text };
const urlRule: FieldRule = {
  normalize: (v) => canonicalDestinationUrl(text(v)) ?? `unparseable:${text(v)}`,
  audit: (v) => auditableDestinationUrl(text(v)),
};

/**
 * Which credential fields decide where each integration type's secret is sent.
 *
 * - Odoo: the `url`, and the `db` — the database picks whose user table checks
 *   the key and whose code handles the login, and on a multi-database server
 *   that can be a different party than the one the key was entered for.
 *   `login` is not a destination: the key still goes to the same server.
 * - IMAP: both hosts, both ports, and `security` — `none` would send the
 *   password in clear text to anyone on the path. `username` is not a
 *   destination.
 *
 * Types missing here (web-search, OAuth types) have a fixed destination or
 * cannot be edited field by field.
 */
const INTEGRATION_DESTINATIONS: Record<
  string,
  { secretField: string; fields: Record<string, FieldRule> }
> = {
  odoo: { secretField: "apiKey", fields: { url: urlRule, db: exactRule } },
  imap: {
    secretField: "password",
    fields: {
      imapHost: hostRule,
      imapPort: portRule,
      smtpHost: hostRule,
      smtpPort: portRule,
      security: exactRule,
    },
  },
};

/**
 * The destination fields an integration update changes, and which secret must
 * come with it — or `null` when the update keeps every destination field (or
 * the type has none). Only fields present in `incoming` are compared, matching
 * the routes' "leave empty to keep current" merge.
 */
export function integrationDestinationChange(
  type: string,
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): { secretField: string; changes: DestinationChanges } | null {
  const rules = INTEGRATION_DESTINATIONS[type];
  if (!rules) return null;
  const changes: DestinationChanges = {};
  for (const [field, rule] of Object.entries(rules.fields)) {
    if (incoming[field] === undefined) continue;
    if (rule.normalize(incoming[field]) === rule.normalize(stored[field])) continue;
    changes[field] = { from: rule.audit(stored[field]), to: rule.audit(incoming[field]) };
  }
  return Object.keys(changes).length > 0 ? { secretField: rules.secretField, changes } : null;
}

/** Field error for a provider/Odoo API key that must be re-entered. */
export const KEY_REQUIRED_FOR_NEW_DESTINATION =
  "Enter the API key again when you change the address — the stored key is never sent to a new address.";

/** Field error for an Odoo API key that must be re-entered. */
export const ODOO_KEY_REQUIRED_FOR_NEW_DESTINATION =
  "Enter the API key again when you change the URL or database — the stored key is never sent to a new destination.";

/** Field error for a mail password that must be re-entered. */
export const PASSWORD_REQUIRED_FOR_NEW_DESTINATION =
  "Enter the password again when you change the server, a port or the security setting — the stored password is never sent to a new destination.";

/** The field error to show for a refused integration update, by type. */
export function secretRequiredMessage(type: string): string {
  if (type === "imap") return PASSWORD_REQUIRED_FOR_NEW_DESTINATION;
  if (type === "odoo") return ODOO_KEY_REQUIRED_FOR_NEW_DESTINATION;
  return KEY_REQUIRED_FOR_NEW_DESTINATION;
}
