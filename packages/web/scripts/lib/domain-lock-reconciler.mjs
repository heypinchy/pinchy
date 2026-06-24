// Pure core of the pre-boot Secure-cookie reconciler.
//
// Better Auth derives the session cookie's `Secure` attribute AND its
// `__Secure-` NAME prefix from `advanced.useSecureCookies`, evaluated once when
// auth.ts is imported. That import is EAGER (server.ts -> ws-auth ->
// @/lib/auth), so it runs before in-process bootInits can write the flag. The
// flag therefore has to already be on disk at process start. The entrypoint
// runner (reconcile-domain-lock-flag.mjs) calls this BEFORE `node` starts.
//
// This MUST stay byte-for-byte compatible with the writer/reader in
// src/lib/secure-cookies.ts (same path, same `<domain>\n` body, same 0o600
// mode). The parity is enforced by domain-lock-reconciler.test.ts.

import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DOMAIN_LOCK_FILE = ".domain_locked";

/** Absolute path of the flag file inside the persistent secrets volume. */
export function domainLockFlagPath(secretsDir) {
  return join(secretsDir, DOMAIN_LOCK_FILE);
}

/**
 * Reconcile the synchronous domain-lock flag from the authoritative `domain`
 * value. A non-empty domain writes the flag (locked = HTTPS/secure mode); a
 * null/empty domain removes it (insecure mode). Never throws — a failed write
 * degrades to non-Secure cookies (login still works) rather than crashing the
 * boot. Returns `{ locked: true|false }` on success, `{ locked: null, warning }`
 * on a filesystem error.
 */
export function reconcileDomainLockFlag({ domain, secretsDir }) {
  const path = domainLockFlagPath(secretsDir);
  try {
    if (typeof domain === "string" && domain.trim().length > 0) {
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(path, `${domain.trim()}\n`, { mode: 0o600 });
      return { locked: true };
    }
    rmSync(path, { force: true });
    return { locked: false };
  } catch (err) {
    return { locked: null, warning: err instanceof Error ? err.message : String(err) };
  }
}
