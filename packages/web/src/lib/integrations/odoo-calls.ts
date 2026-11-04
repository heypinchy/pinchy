import { OdooClient, OdooError } from "odoo-node";

/**
 * odoo-node calls the web app makes, refusing an answer that is not what Odoo
 * sends.
 *
 * odoo-node hands back whatever `result` the server sent. A JSON-RPC server
 * that is not Odoo can answer `{"result": null}`: taken as a uid, it is stored
 * on the connection and breaks every later call; inside `fields()` and
 * `version()` it becomes odoo-node's own TypeError, which reads like a bug in
 * Pinchy rather than a URL pointing at the wrong server.
 *
 * Each error has odoo-node's HTTP-level shape (a status `code`, no `data`), so
 * `isOdooAuthFailure` reads it as "Odoo didn't answer as expected", not as
 * wrong credentials, and a schema sync never takes it for an access denial.
 */
function notOdooAnswer(what: string): OdooError {
  return new OdooError(`Odoo's ${what}. Check that the URL points at the Odoo server itself.`, 200);
}

/**
 * odoo-node turning a non-object `result` into a TypeError — not the
 * JSON-RPC-envelope one (`… (reading 'message')`), which `describeOdooError`
 * already names. The calls wrapped here run nothing of ours in between.
 */
function isNullResultTypeError(err: unknown): boolean {
  return err instanceof TypeError && !/\(reading 'message'\)$/.test(err.message);
}

/** `OdooClient.authenticate`, refusing an answer that carries no user id. */
export async function authenticateOdoo(
  auth: Parameters<typeof OdooClient.authenticate>[0]
): Promise<number> {
  const uid: unknown = await OdooClient.authenticate(auth);
  if (typeof uid === "number" && Number.isInteger(uid) && uid > 0) return uid;
  throw notOdooAnswer("login answer carried no user id");
}

/** `client.fields(model)`, refusing an answer that carries no fields. */
export async function readOdooFields(
  client: OdooClient,
  model: string
): Promise<Awaited<ReturnType<OdooClient["fields"]>>> {
  try {
    return await client.fields(model);
  } catch (err) {
    if (isNullResultTypeError(err)) throw notOdooAnswer("fields_get answer carried no fields");
    throw err;
  }
}

/** `client.version()`, refusing an answer that carries no server version. */
export async function readOdooVersion(
  client: OdooClient
): Promise<Awaited<ReturnType<OdooClient["version"]>>> {
  try {
    return await client.version();
  } catch (err) {
    if (isNullResultTypeError(err)) throw notOdooAnswer("version answer carried no server version");
    throw err;
  }
}
