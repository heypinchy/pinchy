// Issue #156: surface WHERE each secret comes from — never its value.
//
// `docker inspect` shows env vars as empty strings when only the file
// fallback is active (auto-generated secret under /app/secrets). That made
// an operator misread "no secret" and rotate secrets that didn't need
// rotating, losing encrypted data. Provenance makes the file fallback
// visible from outside the container.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getSecretSource, type SecretSource } from "@/lib/encryption";

export type DbPasswordSource = "custom" | "default" | "generated";

/** Default password baked into docker-compose.yml (`DB_PASSWORD:-pinchy_dev`). */
const DEFAULT_DB_PASSWORD_MARKER = ":pinchy_dev@";

/** Written by scripts/resolve-db-password.mjs during the entrypoint. */
const DB_PASSWORD_FILE = ".db_password";

export interface SecretsProvenance {
  encryption_key: SecretSource;
  auth_secret: SecretSource;
  audit_hmac_secret: SecretSource;
  db_password: DbPasswordSource;
}

/**
 * Better Auth reads BETTER_AUTH_SECRET from the environment. The preload
 * (server-preload.cjs) may have filled that env var from the secrets-volume
 * file — it marks that via PINCHY_AUTH_SECRET_SOURCE so the provenance can
 * tell the two apart.
 */
export function getAuthSecretSource(): SecretSource {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value || value.trim().length === 0) return "unset";
  return process.env.PINCHY_AUTH_SECRET_SOURCE === "file" ? "file" : "envvar";
}

export function getDbPasswordSource(databaseUrl: string | undefined): DbPasswordSource {
  const url = databaseUrl ?? "";
  if (!url || url.includes(DEFAULT_DB_PASSWORD_MARKER)) return "default";

  // The entrypoint's auto-migration (#156) rewrites the URL with the password
  // persisted in the secrets volume. When the URL password matches that file,
  // the credential is ours, not the operator's.
  const filePath = join(process.env.ENCRYPTION_KEY_DIR || "/app/secrets", DB_PASSWORD_FILE);
  try {
    if (existsSync(filePath)) {
      const persisted = readFileSync(filePath, "utf-8").trim();
      if (persisted && new URL(url).password === persisted) return "generated";
    }
  } catch {
    // Unparseable URL or unreadable file — fall through to "custom".
  }
  return "custom";
}

export function getSecretsProvenance(): SecretsProvenance {
  return {
    encryption_key: getSecretSource("encryption_key"),
    auth_secret: getAuthSecretSource(),
    audit_hmac_secret: getSecretSource("audit_hmac_secret"),
    db_password: getDbPasswordSource(process.env.DATABASE_URL),
  };
}

export interface DbPasswordPolicyResult {
  action: "warn" | "none";
  message?: string;
}

/**
 * Issue #156: the entrypoint auto-migrates installs off the default database
 * password (scripts/resolve-db-password.mjs). If the server still sees the
 * default URL, that migration failed or was skipped — warn loudly, but never
 * refuse to start: a hard exit would break exactly the unattended installs
 * the auto-migration exists to protect.
 */
export function evaluateDbPasswordPolicy(opts: {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
}): DbPasswordPolicyResult {
  if (getDbPasswordSource(opts.databaseUrl) !== "default") {
    return { action: "none" };
  }
  if (opts.nodeEnv === "production") {
    return {
      action: "warn",
      message:
        "WARNING: Running on the default database password — the boot-time " +
        "password migration failed or was skipped (see [db-password] log lines " +
        "above). Set DB_PASSWORD in your .env, or fix the secrets volume so the " +
        "migration can run.",
    };
  }
  return {
    action: "warn",
    message: "WARNING: Using default DB_PASSWORD. Set a secure password via .env for production.",
  };
}
