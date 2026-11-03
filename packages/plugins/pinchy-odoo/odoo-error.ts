/** Longest odoo-node error message handed to the model or reported to Pinchy. */
export const MAX_ODOO_ERROR_LENGTH = 1000;

export const NOT_JSON_RPC_MESSAGE =
  "Odoo answered with something that is not a JSON-RPC response, so it was not passed on. " +
  "The connection's URL may not point at the Odoo server itself — tell the user that an admin " +
  "should check the connection in Settings → Integrations.";

/**
 * The text an `odoo-node` failure may carry into a tool result, or into the
 * auth-failure reason Pinchy shows admins.
 *
 * `odoo-node` 0.3.0 wraps network failures, HTTP errors and Odoo's own
 * JSON-RPC errors in an `OdooError`. It does not wrap an answer that is not
 * JSON-RPC at all: `response.json()` throws V8's `SyntaxError`, which quotes
 * the start of the body — `Unexpected token 'm', "my-ec2-role-name\n" is not
 * valid JSON`. The client follows redirects, so that body can come from a host
 * that is not Odoo (a metadata service, a captive portal), and a tool result
 * goes to the model and from there to a chat user who may not be an admin. A
 * JSON answer of the wrong shape fails one step later as a `TypeError`
 * reading `error.data.message`; it carries nothing the model can act on
 * either, so both get the same plain sentence.
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
  if (err instanceof SyntaxError || err instanceof TypeError) return NOT_JSON_RPC_MESSAGE;
  const message = (err instanceof Error ? err.message : "").replace(/\s+/g, " ").trim();
  if (!message) return "Unknown error";
  return message.length > MAX_ODOO_ERROR_LENGTH
    ? `${message.slice(0, MAX_ODOO_ERROR_LENGTH)}…`
    : message;
}
