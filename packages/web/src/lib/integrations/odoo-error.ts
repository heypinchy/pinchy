/** Longest Odoo error message handed back to an admin. */
const MAX_LENGTH = 300;

/**
 * What an admin is told when Odoo answered with a redirect. Pinchy follows
 * none: its URL check reads the address entered, and a 307/308 would re-send
 * the API key to wherever the redirect points.
 */
export function odooRedirectRefusedMessage(status: number | string): string {
  return (
    `Odoo answered with a redirect (HTTP ${status}), and Pinchy does not follow redirects. ` +
    "Enter the address Odoo is actually served from — if this URL starts with http://, that is usually its https:// address."
  );
}

/**
 * The message an admin is shown when an `odoo-node` call fails.
 *
 * `odoo-node` wraps network failures, HTTP errors (`HTTP 502: Bad Gateway`),
 * refused redirects and Odoo's own JSON-RPC errors in an `OdooError`, whose
 * message is meant for people and never quotes a response body. An answer
 * that is not JSON-RPC at all comes back as `Response is not JSON-RPC (HTTP
 * 200, text/html)`; that is rephrased to say what it means for the admin —
 * the URL does not point at Odoo — keeping status and content type. A
 * JSON-RPC envelope of the wrong shape (`{"error": {}}`) still escapes as a
 * `TypeError` reading `error.data.message`, which says nothing useful, so it
 * gets the plain sentence alone; any other `TypeError` is a bug on our side
 * and says so. odoo-node's refused-redirect message names the library; the
 * admin gets `odooRedirectRefusedMessage` instead, the same sentence listing
 * databases shows.
 *
 * Everything else passes through, collapsed to one line and capped, so even
 * an Odoo-shaped error from a misbehaving server cannot fill a toast with a
 * page of text.
 */
/**
 * A `TypeError` that is not odoo-node reading `error.data.message` off a
 * JSON-RPC error without `data`: a bug on our side. The test is on V8's
 * message alone, so a bug of ours that reads `message` off undefined is taken
 * for the envelope case — the code paths that feed these functions call
 * odoo-node and little else, and nothing in them reads `.message` that way.
 */
function isInternalTypeError(err: unknown): err is TypeError {
  return err instanceof TypeError && !/\(reading 'message'\)$/.test(err.message);
}

export function describeOdooError(err: unknown): string {
  const notOdoo = "Check that the URL points at the Odoo server itself.";
  if (err instanceof TypeError) {
    if (!isInternalTypeError(err)) {
      return `Odoo answered with something that is not a JSON-RPC response. ${notOdoo}`;
    }
    return (
      `Pinchy hit an internal error while talking to Odoo (TypeError: ${err.message}). ` +
      "This is not a problem with the connection's settings."
    );
  }
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  const notJsonRpc = /^Response is not JSON-RPC (\(.*\))$/.exec(message);
  if (notJsonRpc) {
    return `Odoo answered with something that is not a JSON-RPC response ${notJsonRpc[1]}. ${notOdoo}`;
  }
  const redirect = /^Odoo answered with a redirect \(HTTP (\d{3})\)/.exec(message);
  if (redirect) return odooRedirectRefusedMessage(redirect[1]);
  if (!message) return "Connection failed";
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}…` : message;
}

/**
 * Is this `odoo-node` failure Odoo refusing the login, as opposed to Pinchy
 * never getting an Odoo answer to judge?
 *
 * Only the first is evidence about the credentials. A redirect (odoo-node
 * 0.3.1 refuses to follow one: an http:// URL behind a proxy's HTTP→HTTPS
 * 307/308 — Caddy's default, common in Traefik setups — is the usual case),
 * an HTTP error from a proxy, a network failure or a non-JSON-RPC answer say
 * nothing about the login or API key — reporting them as an authentication
 * failure sends the admin to fix the wrong thing, and flags a healthy
 * connection `auth_failed`.
 *
 * odoo-node builds the shapes this reads: a JSON-RPC error from Odoo carries
 * Odoo's `data`; a transport failure carries only a numeric `code` (0 for the
 * network, the HTTP status otherwise) — and so does the one auth error
 * odoo-node raises itself, `"Authentication failed"`, when Odoo answers
 * `uid: false`. Anything else, including an error of a shape this does not
 * know, keeps being treated as an authentication failure, as before.
 */
export function isOdooAuthFailure(err: unknown): boolean {
  if (err instanceof TypeError) return false;
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
  // Our own bug: neither a refused login nor Odoo misbehaving.
  if (isInternalTypeError(err)) return { success: false, transient: true, reason: detail };
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
