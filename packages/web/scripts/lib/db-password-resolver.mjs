// Boot-time auto-migration away from the default database password (#156).
//
// docker-compose.yml interpolates DATABASE_URL with `${DB_PASSWORD:-pinchy_dev}`,
// and the default value is public in this repository. Instead of refusing to
// start (breaking every install that never set DB_PASSWORD), the entrypoint
// resolves the real password before anything touches the database:
//
//   - Explicit DB_PASSWORD in .env always wins. If the database itself still
//     runs on an older password (operator set .env but forgot ALTER USER),
//     the resolver performs the ALTER USER automatically.
//   - With the default password, a random one is generated, persisted to the
//     secrets volume (same pattern as getOrCreateSecret), and applied via
//     ALTER USER. Persist-before-alter makes every crash point recoverable.
//   - When migration is impossible (db down, volume read-only), the resolver
//     returns the original URL with a warning — never fail closed.
//
// Plain .mjs (no TypeScript, no path aliases): entrypoint.sh runs this with
// plain `node` before drizzle-kit and the server start. All effectful deps
// (probe/alter/fs) are injected — see db-password-deps.mjs for the real ones.

import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const DEFAULT_DB_PASSWORD = "pinchy_dev";
export const DB_PASSWORD_FILE = ".db_password";

export function replaceUrlPassword(databaseUrl, password) {
  const url = new URL(databaseUrl);
  url.password = password;
  return url.toString();
}

export function generateDbPassword() {
  // 64 hex chars — same shape as the other auto-generated secrets, and
  // trivially safe inside a connection URL and a quoted SQL literal.
  return randomBytes(32).toString("hex");
}

function urlPassword(databaseUrl) {
  return decodeURIComponent(new URL(databaseUrl).password);
}

function urlUsername(databaseUrl) {
  return decodeURIComponent(new URL(databaseUrl).username);
}

/**
 * Resolve the effective DATABASE_URL, migrating the database off the default
 * password when necessary.
 *
 * @returns {Promise<{url: string, source: "custom"|"generated"|"default", migrated?: boolean, warning?: string}>}
 */
export async function resolveDbPassword({ databaseUrl, secretsDir, deps }) {
  const filePath = join(secretsDir, DB_PASSWORD_FILE);
  const username = urlUsername(databaseUrl);
  const envPassword = urlPassword(databaseUrl);
  const filePassword = deps.readFile(filePath)?.trim() || null;

  if (envPassword !== DEFAULT_DB_PASSWORD) {
    // Operator-managed password. Normally it just works…
    if (await deps.probe(databaseUrl)) {
      return { url: databaseUrl, source: "custom" };
    }
    // …but if the database still runs on a previously generated or the
    // default password, heal the mismatch instead of crashing later.
    for (const candidate of [filePassword, DEFAULT_DB_PASSWORD]) {
      if (!candidate) continue;
      const candidateUrl = replaceUrlPassword(databaseUrl, candidate);
      if (await deps.probe(candidateUrl)) {
        try {
          await deps.alterPassword(candidateUrl, username, envPassword);
        } catch (err) {
          return {
            url: databaseUrl,
            source: "custom",
            warning: `failed to apply DB_PASSWORD via ALTER USER: ${message(err)}`,
          };
        }
        if (candidate === filePassword) deps.deleteFile(filePath);
        deps.log("applied DB_PASSWORD from the environment via ALTER USER");
        return { url: databaseUrl, source: "custom", migrated: true };
      }
    }
    return {
      url: databaseUrl,
      source: "custom",
      warning: "could not connect with DB_PASSWORD, the persisted, or the default password",
    };
  }

  // DATABASE_URL carries the public default password.
  if (filePassword) {
    const fileUrl = replaceUrlPassword(databaseUrl, filePassword);
    if (await deps.probe(fileUrl)) {
      // Steady state: migrated on an earlier boot.
      return { url: fileUrl, source: "generated" };
    }
    if (await deps.probe(databaseUrl)) {
      // Crash window recovery: the file was persisted but ALTER USER never
      // ran. Finish the migration with the already-persisted password.
      try {
        await deps.alterPassword(databaseUrl, username, filePassword);
      } catch (err) {
        return {
          url: databaseUrl,
          source: "default",
          warning: `password migration failed during recovery: ${message(err)}`,
        };
      }
      deps.log("completed interrupted password migration");
      return { url: fileUrl, source: "generated", migrated: true };
    }
    return {
      url: databaseUrl,
      source: "default",
      warning: "could not connect with the persisted or the default password",
    };
  }

  // First boot on the default password: migrate.
  if (!(await deps.probe(databaseUrl))) {
    return {
      url: databaseUrl,
      source: "default",
      warning: "database unreachable — skipping password migration",
    };
  }
  const newPassword = generateDbPassword();
  try {
    // Persist BEFORE altering: a crash after the write is recoverable (see
    // above), a password change without the file would lock us out.
    deps.writeFile(filePath, newPassword);
    const readBack = deps.readFile(filePath)?.trim();
    if (readBack !== newPassword) {
      throw new Error("read-back of the persisted password does not match");
    }
  } catch (err) {
    return {
      url: databaseUrl,
      source: "default",
      warning: `cannot persist generated password (${message(err)}) — keeping the default`,
    };
  }
  try {
    await deps.alterPassword(databaseUrl, username, newPassword);
  } catch (err) {
    // The persisted file stays — the recovery path above finishes the job
    // on the next boot.
    return {
      url: databaseUrl,
      source: "default",
      warning: `ALTER USER failed (${message(err)}) — will retry on next boot`,
    };
  }
  deps.log("migrated the database off the default password (auto-generated credential persisted)");
  return { url: replaceUrlPassword(databaseUrl, newPassword), source: "generated", migrated: true };
}

function message(err) {
  return err instanceof Error ? err.message : String(err);
}
