// Reads the authoritative `domain` setting straight from Postgres, for the
// pre-boot Secure-cookie reconciler (reconcile-domain-lock-flag.mjs). Uses the
// same `postgres` client the rest of the entrypoint tooling uses. Kept separate
// from the pure reconciler so the file logic stays unit-testable while this DB
// edge is covered by domain-lock-reconciler.integration.test.ts.

import postgres from "postgres";

/**
 * Return the locked domain (HTTPS/secure mode) or null (insecure mode).
 *
 * `domain` is always stored plaintext (settings.encrypted = false; see
 * lib/settings.ts). A row that is unexpectedly flagged encrypted is treated as
 * not-locked: the pre-boot context has no key to decrypt it, and degrading to
 * insecure keeps login working rather than writing ciphertext as a domain.
 */
export async function readDomainSetting(url) {
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const rows = await sql`SELECT value, encrypted FROM settings WHERE key = 'domain'`;
    if (rows.length === 0) return null;
    const { value, encrypted } = rows[0];
    if (encrypted) return null;
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
