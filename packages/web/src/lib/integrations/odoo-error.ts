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
