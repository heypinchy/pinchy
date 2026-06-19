/**
 * Deterministic `Secure`-cookie decision for Better Auth.
 *
 * Better Auth derives the session cookie's `Secure` attribute AND its
 * `__Secure-` NAME prefix from `advanced.useSecureCookies`, evaluated once when
 * the auth instance is constructed (module-import time). Pinchy used to feed
 * that from `getCachedDomain()`, an async-loaded IN-MEMORY cache that is cold at
 * import (and can fail to load). The value therefore differed between container
 * generations, the cookie NAME flipped (`__Secure-better-auth.session_token` ↔
 * `better-auth.session_token`), the browser's existing cookie was orphaned, and
 * every update logged users out. (Domain Lock is the documented source of truth
 * for "secure mode", so the signal is correct — only its timing was not.)
 *
 * Fix: mirror the domain-lock state to a synchronously-readable file in the
 * persistent secrets volume (the same volume `.db_password` and the generated
 * encryption key live in). Read it synchronously at import — deterministic and
 * stable across restarts. The DB setting remains the source of truth; this file
 * is a sync cache kept in step on every lock/unlock and on each boot.
 *
 * Node-only (uses `fs`). Do NOT import from Edge middleware — use
 * `@/lib/domain-cache`'s `getCachedDomain()` there.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

const DOMAIN_LOCK_FILE = ".domain_locked";

/** Persistent secrets volume — same dir as the generated encryption key / `.db_password`. */
function secretsDir(): string {
  return process.env.ENCRYPTION_KEY_DIR || "/app/secrets";
}

export function domainLockFlagPath(): string {
  return join(secretsDir(), DOMAIN_LOCK_FILE);
}

/**
 * Persist the domain-lock state to the sync-readable flag file. A non-empty
 * domain writes the file; `null`/empty removes it. Never throws — a failed
 * write degrades to the insecure-but-functional default (login still works)
 * rather than crashing a lock/unlock or boot. Called from domain.ts whenever
 * the domain setting changes and on boot (backfill for already-locked installs).
 */
export function writeDomainLockFlag(domain: string | null): void {
  const path = domainLockFlagPath();
  try {
    if (domain && domain.trim().length > 0) {
      mkdirSync(secretsDir(), { recursive: true });
      writeFileSync(path, `${domain.trim()}\n`, { mode: 0o600 });
    } else {
      rmSync(path, { force: true });
    }
  } catch (err) {
    // Fail-safe: leave the flag as-is. Worst case is non-Secure cookies on a
    // locked instance until the next successful write — degraded, not broken.
    console.warn(
      "[secure-cookies] Failed to persist domain-lock flag:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Synchronous, deterministic: should auth cookies be issued `Secure` (and get
 * the `__Secure-` name prefix)? True iff a domain is locked (HTTPS/secure mode),
 * read from the persistent flag file. Never throws; defaults to `false`
 * (insecure mode) so a missing/unreadable flag can never set `__Secure-` over
 * plain HTTP, which browsers reject (that would break login entirely).
 */
export function shouldUseSecureCookies(): boolean {
  try {
    const path = domainLockFlagPath();
    if (!existsSync(path)) return false;
    return readFileSync(path, "utf-8").trim().length > 0;
  } catch {
    return false;
  }
}
