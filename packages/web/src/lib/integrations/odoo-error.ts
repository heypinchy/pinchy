/** Longest Odoo error message handed back to an admin. */
const MAX_LENGTH = 300;

/**
 * The message an admin is shown when an `odoo-node` call fails.
 *
 * `odoo-node` wraps network failures, HTTP errors (`HTTP 502: Bad Gateway`)
 * and Odoo's own JSON-RPC errors in an `OdooError`, whose message is meant
 * for people. What it does NOT wrap is an answer that is not JSON-RPC at all:
 * `response.json()` throws a `SyntaxError`, and Node's parser quotes the first
 * characters of what it choked on — `Unexpected token '<', "<html>SECR"...`.
 * That is a slice of a response body nobody asked for, from a host that may
 * not be Odoo (a captive portal, a proxy, whatever a redirect led to), and it
 * must not reach the admin. A JSON answer of the wrong shape fails one step
 * later as a `TypeError` reading `error.data.message`; it says nothing more
 * useful than the `SyntaxError` does, so both get the same plain sentence.
 *
 * Everything else passes through, collapsed to one line and capped, so even
 * an Odoo-shaped error from a misbehaving server cannot fill a toast with a
 * page of text.
 */
export function describeOdooError(err: unknown): string {
  if (err instanceof SyntaxError || err instanceof TypeError) {
    return (
      "Odoo answered with something that is not a JSON-RPC response. " +
      "Check that the URL points at the Odoo server itself."
    );
  }
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  if (!message) return "Connection failed";
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}…` : message;
}

/**
 * Is this `odoo-node` failure Odoo refusing the login, as opposed to Pinchy
 * never getting an Odoo answer to judge?
 *
 * Only the first is evidence about the credentials. A redirect (odoo-node
 * 0.3.1 refuses to follow one: an http:// URL behind Caddy's or Traefik's
 * default HTTP→HTTPS 307/308 is the common case), an HTTP error from a proxy,
 * a network failure or a non-JSON-RPC answer say nothing about the login or
 * API key — reporting them as an authentication failure sends the admin to
 * fix the wrong thing, and flags a healthy connection `auth_failed`.
 *
 * odoo-node builds the shapes this reads: a JSON-RPC error from Odoo carries
 * Odoo's `data`; a transport failure carries only a numeric `code` (0 for the
 * network, the HTTP status otherwise) — and so does the one auth error
 * odoo-node raises itself, `"Authentication failed"`, when Odoo answers
 * `uid: false`. Anything else, including an error of a shape this does not
 * know, keeps being treated as an authentication failure, as before.
 */
export function isOdooAuthFailure(err: unknown): boolean {
  if (err instanceof SyntaxError || err instanceof TypeError) return false;
  if (!(err instanceof Error)) return true;
  const { code, data } = err as Error & { code?: unknown; data?: unknown };
  const isTransport =
    typeof code === "number" && data === undefined && err.message !== "Authentication failed";
  return !isTransport;
}

/**
 * The probe result for a failed `OdooClient.authenticate`. Used by the probe
 * and by the Test-connection route's uid self-heal, which authenticates first and must
 * classify the same failure the same way.
 */
export function describeOdooAuthenticateFailure(err: unknown): {
  success: false;
  reason: string;
  transient?: boolean;
} {
  const detail = describeOdooError(err);
  if (isOdooAuthFailure(err)) {
    return {
      success: false,
      reason: `Authentication failed. Please verify your login and API key. (${detail})`,
    };
  }
  return {
    success: false,
    transient: true,
    reason: `Odoo didn't answer as expected, so your login and API key weren't checked. (${detail})`,
  };
}
