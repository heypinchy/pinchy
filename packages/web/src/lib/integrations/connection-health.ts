import { maskConnectionCredentials } from "./mask-credentials";

/** A connection row as stored in the DB (only the fields health derivation needs). */
export interface ConnectionHealthRow {
  type: string;
  credentials: string;
  status: string;
}

/**
 * A connection cannot be decrypted when its stored credentials fail to decrypt —
 * e.g. the ENCRYPTION_KEY changed and this row was written under the old key.
 *
 * This is NOT a DB `status`; it is derived by attempting the same masking/decrypt
 * step that `GET /api/integrations` performs per row. Keeping the derivation here
 * lets both the list route and the health-count route agree on what "unreadable"
 * means without duplicating the try/catch.
 */
export function isCannotDecrypt(
  conn: Pick<ConnectionHealthRow, "type" | "credentials">,
  decrypt: (ciphertext: string) => string
): boolean {
  try {
    maskConnectionCredentials(conn.type, conn.credentials, decrypt);
    return false;
  } catch {
    return true;
  }
}

/**
 * A connection "needs attention" when the runtime rejected its credentials
 * (`status === "auth_failed"`) OR the stored credentials can no longer be
 * decrypted (`cannotDecrypt`). Both are actionable, unreadable/broken states an
 * admin must resolve, so the sidebar badge and the Integrations-tab error dot
 * count both.
 */
export function needsAttention(
  conn: ConnectionHealthRow,
  decrypt: (ciphertext: string) => string
): boolean {
  return conn.status === "auth_failed" || isCannotDecrypt(conn, decrypt);
}

export interface IntegrationHealthCounts {
  authFailedCount: number;
  cannotDecryptCount: number;
  needsAttentionCount: number;
}

/**
 * Count the "needs attention" states across all connections.
 *
 * `needsAttentionCount` is the union (auth_failed OR cannotDecrypt) and drives
 * the badge/dot. `authFailedCount` and `cannotDecryptCount` are the individual
 * breakdowns; a single row can be counted in both when it is auth_failed AND
 * unreadable, but it contributes to `needsAttentionCount` only once.
 */
export function countIntegrationHealth(
  connections: ConnectionHealthRow[],
  decrypt: (ciphertext: string) => string
): IntegrationHealthCounts {
  let authFailedCount = 0;
  let cannotDecryptCount = 0;
  let needsAttentionCount = 0;
  for (const conn of connections) {
    const authFailed = conn.status === "auth_failed";
    const cannotDecrypt = isCannotDecrypt(conn, decrypt);
    if (authFailed) authFailedCount++;
    if (cannotDecrypt) cannotDecryptCount++;
    if (authFailed || cannotDecrypt) needsAttentionCount++;
  }
  return { authFailedCount, cannotDecryptCount, needsAttentionCount };
}
