// Its own module, free of Node imports: odoo-error.ts names the bound, and
// odoo-sync.ts (which imports odoo-error) is also imported by client code. Here
// in odoo-pin.ts it would pull undici and node:net into the browser bundle.

/**
 * How long one Odoo request may take, response body included, before Pinchy
 * gives up on it. Every call the web app makes is metadata — authenticate,
 * version, fields_get, check_access_rights — which a healthy Odoo serves in
 * well under a second, and a busy one (the schema sync keeps up to 20 requests
 * in flight) in seconds. The slowest legitimate answer is a cold Odoo loading
 * its registry on the first request after a restart, which can take tens of
 * seconds on a large database. Odoo's own worker limit, `limit_time_cpu`,
 * defaults to 60 seconds: a request that needed more would be killed by Odoo
 * itself. Past this an answer is not coming — an Odoo, or a proxy in front of
 * it, that took the connection and went silent — and the admin waiting on
 * the page is better served by "did not answer in time" than by undici's
 * 300-second default. Kept below the plugin's 120 s, which also covers an
 * agent's large search_read.
 */
export const ODOO_REQUEST_TIMEOUT_MS = 60_000;
