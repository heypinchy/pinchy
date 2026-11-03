/** Longest odoo-node error message handed to the model or reported to Pinchy. */
export const MAX_ODOO_ERROR_LENGTH = 1000;

export const NOT_JSON_RPC_MESSAGE =
  "Odoo answered with something that is not a JSON-RPC response, so it was not passed on. " +
  "The connection's URL may not point at the Odoo server itself — tell the user that an admin " +
  "should check the connection in Settings → Integrations.";

/** What the model is told when odoo-node refused to follow a redirect. */
function redirectMessage(status: string): string {
  return (
    `Odoo answered with a redirect (HTTP ${status}), and redirects are not followed. ` +
    "The connection's URL may not be the address Odoo is served from — " +
    "tell the user that an admin should check the connection in Settings → Integrations."
  );
}

/**
 * The text an `odoo-node` failure may carry into a tool result, or into the
 * auth-failure reason Pinchy shows admins.
 *
 * `odoo-node` wraps network failures, HTTP errors and Odoo's own JSON-RPC
 * errors in an `OdooError`. Two of its messages describe an answer it refused
 * to read rather than Odoo talking, and both are addressed to whoever set up
 * the URL — which the model is not:
 *
 * - `Odoo answered with a redirect (HTTP 307); …`: odoo-node never follows a
 *   redirect, because a 307/308 would re-send the API key to an address
 *   nobody validated.
 * - `Response is not JSON-RPC (HTTP 200, text/plain)`: the answer was a page,
 *   or a metadata service's plain text — anything but Odoo. odoo-node names
 *   status and content type, never the body.
 *
 * The model gets a sentence it can relay instead. A JSON-RPC envelope of the
 * wrong shape (`{"error": {}}`) still escapes odoo-node as a `TypeError`
 * reading `error.data.message`, which tells the model nothing either.
 *
 * Everything else is Odoo talking — a validation error, an access error — and
 * the model needs its words, so it passes through, collapsed to one line and
 * capped. The cap is wider than the 300 characters the web app's
 * `describeOdooError` allows for a toast: an Odoo validation message naming
 * several fields is what lets the model correct its call.
 *
 * Classify the RAW error before calling this (`isAuthError`,
 * `isOdooAccessError`, the integer-syntax hint): this is for display only.
 *
 * Deliberately a plugin-local function rather than code shared with
 * `packages/web/src/lib/integrations/odoo-error.ts`: the two answer different
 * readers (an admin who can fix the URL, a model that can only relay it) with
 * different sentences and limits, and sharing ten lines would cost a
 * cross-package drift guard.
 */
export function describeOdooError(err: unknown): string {
  if (err instanceof TypeError) return NOT_JSON_RPC_MESSAGE;
  const message = (err instanceof Error ? err.message : "").replace(/\s+/g, " ").trim();
  if (!message) return "Unknown error";
  if (message.startsWith("Response is not JSON-RPC")) return NOT_JSON_RPC_MESSAGE;
  const redirect = /^Odoo answered with a redirect \(HTTP (\d{3})\)/.exec(message);
  if (redirect) return redirectMessage(redirect[1]);
  return message.length > MAX_ODOO_ERROR_LENGTH
    ? `${message.slice(0, MAX_ODOO_ERROR_LENGTH)}…`
    : message;
}
