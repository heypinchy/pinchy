#!/usr/bin/env node
// Entrypoint runner: reconcile the Secure-cookie (domain-lock) flag from the DB
// BEFORE the Node server starts.
//
// Better Auth reads `advanced.useSecureCookies` when auth.ts is imported, which
// is EAGER (server.ts -> ws-auth -> @/lib/auth) — too early for in-process
// bootInits to write the flag. Writing it here, pre-node and after migrations,
// makes the very first boot after a domain-locked upgrade already issue
// Secure/`__Secure-` cookies: the cookie name never flips, so users are not
// logged out and the instance is never briefly served non-Secure cookies.
//
// All diagnostics go to stderr. ALWAYS exits 0 — a failed reconcile must never
// block the boot (it degrades to non-Secure cookies; login still works).

import { readDomainSetting } from "./lib/domain-setting-reader.mjs";
import { reconcileDomainLockFlag } from "./lib/domain-lock-reconciler.mjs";

const log = (msg) => process.stderr.write(`[domain-lock] ${msg}\n`);

const databaseUrl = process.env.DATABASE_URL;
const secretsDir = process.env.ENCRYPTION_KEY_DIR || "/app/secrets";

if (!databaseUrl) {
  log("no DATABASE_URL — skipping (Secure-cookie flag left as-is)");
  process.exit(0);
}

try {
  const domain = await readDomainSetting(databaseUrl);
  const result = reconcileDomainLockFlag({ domain, secretsDir });
  if (result.warning) {
    log(`WARNING: could not persist flag: ${result.warning}`);
  } else if (result.locked) {
    log(`locked: Secure (__Secure-) cookies ON for ${domain}`);
  } else {
    log("unlocked: Secure cookies OFF (no domain set)");
  }
} catch (err) {
  log(`WARNING: ${err instanceof Error ? err.message : err}`);
}

process.exit(0);
