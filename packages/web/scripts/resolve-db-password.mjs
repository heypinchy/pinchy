#!/usr/bin/env node
// Entrypoint runner for the DB password auto-migration (#156).
//
// Called by entrypoint.sh BEFORE drizzle-kit migrate and the server start,
// because both consume DATABASE_URL. Prints the resolved URL to stdout
// (nothing when the URL is unchanged); all diagnostics go to stderr so the
// captured stdout never mixes with logs. Always exits 0 — a failed migration
// must not block the boot (the server warns loudly instead).

import { resolveDbPassword } from "./lib/db-password-resolver.mjs";
import { createDbPasswordDeps } from "./lib/db-password-deps.mjs";

const log = (msg) => process.stderr.write(`[db-password] ${msg}\n`);

// Defense in depth: the production entrypoint is the only intended caller
// (Dockerfile.pinchy sets NODE_ENV=production globally). Dev stacks keep the
// well-known dev password so host-side tooling stays usable.
if (process.env.NODE_ENV !== "production") {
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.exit(0);
}

const secretsDir = process.env.ENCRYPTION_KEY_DIR || "/app/secrets";

try {
  const result = await resolveDbPassword({
    databaseUrl,
    secretsDir,
    deps: createDbPasswordDeps({ log }),
  });
  if (result.warning) {
    log(`WARNING: ${result.warning}`);
  }
  if (result.url !== databaseUrl) {
    process.stdout.write(result.url);
  }
} catch (err) {
  log(
    `WARNING: unexpected error during password resolution: ${err instanceof Error ? err.message : err}`
  );
}
