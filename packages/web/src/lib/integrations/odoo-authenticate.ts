import { OdooClient, OdooError } from "odoo-node";

/**
 * `OdooClient.authenticate`, refusing an answer that carries no user id.
 *
 * odoo-node returns whatever `result` the server sent. A JSON-RPC server that
 * is not Odoo can answer `{"result": null}`; taken as a uid, that is stored on
 * the connection and breaks every later call. A refused login is still
 * odoo-node's own "Authentication failed" (Odoo answers `false`).
 *
 * The error has odoo-node's HTTP-level shape (a status `code`, no `data`), so
 * `isOdooAuthFailure` reads it as "Odoo didn't answer as expected", not as
 * wrong credentials.
 */
export async function authenticateOdoo(
  auth: Parameters<typeof OdooClient.authenticate>[0]
): Promise<number> {
  const uid: unknown = await OdooClient.authenticate(auth);
  if (typeof uid === "number" && Number.isInteger(uid) && uid > 0) return uid;
  throw new OdooError(
    "Odoo's login answer carried no user id. Check that the URL points at the Odoo server itself.",
    200
  );
}
