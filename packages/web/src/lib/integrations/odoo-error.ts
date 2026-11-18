import { ODOO_REQUEST_TIMEOUT_MS } from "./odoo-timeout";

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
 * Did the pinned fetch's bound (`ODOO_REQUEST_TIMEOUT_MS`) cut this request
 * off? odoo-node wraps the abort into an `OdooError` with code 0 and keeps
 * the `TimeoutError` that `AbortSignal.timeout` raised as its `cause` — for a
 * reply that never started and for a body that stopped arriving alike. A
 * caller's own cancellation is an `AbortError` and is not one.
 */
export function isOdooTimeout(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    if ((e as { name?: unknown }).name === "TimeoutError") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** What an admin is told when Odoo took the connection and never answered. */
export function odooTimeoutMessage(): string {
  return (
    `Odoo did not answer within ${ODOO_REQUEST_TIMEOUT_MS / 1000} seconds. ` +
    "The server took the connection but sent no reply: check that Odoo is running and not overloaded, " +
    "and that nothing in front of it, such as a proxy or firewall, holds the request."
  );
}

/**
 * The system error code behind undici's bare "fetch failed", such as
 * `ECONNREFUSED`. undici throws a `TypeError("fetch failed")` and keeps the
 * socket's error, with its `code`, as `cause`; odoo-node wraps that TypeError
 * in turn (code 0). Only the code is read — the system error's message names
 * the address — and only one that looks like an error code.
 */
function fetchFailureCode(err: unknown): string | undefined {
  let failed = false;
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    if ((e as { message?: unknown }).message === "fetch failed") failed = true;
    const code = (e as { code?: unknown }).code;
    if (failed && typeof code === "string") {
      return /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * What an admin is told about a connection that failed before Odoo could
 * answer — undici's "fetch failed" with a system error code behind it — or
 * `undefined` when `err` is not one. For callers that fetch Odoo without
 * odoo-node, such as listing databases; `describeOdooError` covers the rest.
 */
export function describeOdooNetworkFailure(err: unknown): string | undefined {
  const code = fetchFailureCode(err);
  return code ? fetchFailureMessage(code) : undefined;
}

function fetchFailureMessage(code: string): string {
  switch (code) {
    case "ECONNREFUSED":
      return `Odoo refused the connection (${code}): check that Odoo is running and listens on the port in the URL.`;
    case "ENOTFOUND":
      return `The Odoo server's name could not be found (${code}): check the host name in the URL.`;
    case "EAI_AGAIN":
      return `Looking up the Odoo server's name failed for the moment (${code}): try again shortly.`;
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      return (
        `The connection to Odoo was closed before it answered (${code}): ` +
        "check that nothing in front of Odoo, such as a proxy or firewall, cuts it off."
      );
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return (
        `Pinchy could not open a connection to Odoo (${code}): ` +
        "check that the server is reachable from Pinchy and that no firewall drops the connection."
      );
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `Pinchy has no route to the Odoo server (${code}): check the network between Pinchy and Odoo.`;
  }
  if (code.includes("CERT") || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")) {
    return (
      `Pinchy did not accept Odoo's TLS certificate (${code}): ` +
      "check that it is valid for this host name, not expired, and issued by a trusted authority."
    );
  }
  return `Pinchy could not connect to Odoo (${code}).`;
}

/**
 * The message an admin is shown when an `odoo-node` call fails.
 *
 * `odoo-node` wraps network failures, HTTP errors (`HTTP 502: Bad Gateway`),
 * refused redirects and Odoo's own JSON-RPC errors in an `OdooError`, whose
 * message is meant for people and never quotes a response body. An answer
 * that is not JSON-RPC at all comes back as `Response is not JSON-RPC (HTTP
 * 200, text/html)`; that is rephrased to say what it means for the admin —
 * the URL does not point at Odoo — keeping status and content type.
 * odoo-node reports a JSON-RPC error envelope that carries no message
 * (`{"error": {}}`) the same way. A `TypeError` is a bug on our side and says
 * so. A request the pinned fetch's bound cut off says Odoo did not answer
 * in time, not undici's "aborted due to timeout". A network failure, which
 * undici reports only as "fetch failed", says what happened from the system
 * error code it carries (`ECONNREFUSED`, `ENOTFOUND`, a TLS certificate
 * code…). odoo-node's refused-redirect message names the library; the
 * admin gets `odooRedirectRefusedMessage` instead, the same sentence listing
 * databases shows.
 *
 * Everything else passes through, collapsed to one line and capped, so even
 * an Odoo-shaped error from a misbehaving server cannot fill a toast with a
 * page of text.
 */
export function describeOdooError(err: unknown): string {
  const notOdoo = "Check that the URL points at the Odoo server itself.";
  if (isOdooTimeout(err)) return odooTimeoutMessage();
  // Before the TypeError check: undici's "fetch failed" is one, and is the
  // network failing, not a bug of ours.
  const networkFailure = describeOdooNetworkFailure(err);
  if (networkFailure) return networkFailure;
  if (err instanceof TypeError) {
    // The name and, from V8's "(reading 'x')", the property — never the
    // free message, which may carry a value.
    const property = /\(reading '([A-Za-z_$][\w$]{0,40})'\)$/.exec(err.message)?.[1];
    const what = property ? `TypeError reading '${property}'` : "TypeError";
    return (
      `Pinchy hit an internal error while talking to Odoo (${what}). ` +
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
 * refuses to follow one: an http:// URL behind a proxy's HTTP→HTTPS
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
 * The probe result for a failed `authenticateOdoo`. Used by the probe and by
 * the Test-connection route's uid self-heal, which authenticates first and
 * must classify the same failure the same way.
 */
export function describeOdooAuthenticateFailure(err: unknown): {
  success: false;
  reason: string;
  transient?: boolean;
} {
  const detail = describeOdooError(err);
  // Our own bug: neither a refused login nor Odoo misbehaving.
  if (err instanceof TypeError) return { success: false, transient: true, reason: detail };
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
