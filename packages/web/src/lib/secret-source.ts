// Issue #156: surface WHERE each secret comes from — never its value.
//
// `docker inspect` shows env vars as empty strings when only the file
// fallback is active (auto-generated secret under /app/secrets). That made
// an operator misread "no secret" and rotate secrets that didn't need
// rotating, losing encrypted data. Provenance makes the file fallback
// visible from outside the container.

import { getSecretSource, type SecretSource } from "@/lib/encryption";

export type DbPasswordSource = "custom" | "default";

/** Default password baked into docker-compose.yml (`DB_PASSWORD:-pinchy_dev`). */
const DEFAULT_DB_PASSWORD_MARKER = ":pinchy_dev@";

export interface SecretsProvenance {
  encryption_key: SecretSource;
  auth_secret: "envvar" | "unset";
  audit_hmac_secret: SecretSource;
  db_password: DbPasswordSource;
}

/**
 * Better Auth reads BETTER_AUTH_SECRET from the environment directly —
 * there is no file fallback for it, so the only sources are env or unset.
 */
export function getAuthSecretSource(): "envvar" | "unset" {
  const value = process.env.BETTER_AUTH_SECRET;
  return value && value.trim().length > 0 ? "envvar" : "unset";
}

export function getDbPasswordSource(databaseUrl: string | undefined): DbPasswordSource {
  return (databaseUrl ?? "").includes(DEFAULT_DB_PASSWORD_MARKER) ? "default" : "custom";
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
  action: "exit" | "warn" | "none";
  message?: string;
}

/**
 * Issue #156: running production on the default database password must be
 * fail-closed, not a log line nobody reads. Pure so server.ts wiring stays
 * a one-liner and the decision table is unit-testable.
 */
export function evaluateDbPasswordPolicy(opts: {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
}): DbPasswordPolicyResult {
  if (getDbPasswordSource(opts.databaseUrl) === "custom") {
    return { action: "none" };
  }
  if (opts.nodeEnv === "production") {
    return {
      action: "exit",
      message:
        "FATAL: Refusing to start in production with the default database password. " +
        "Set DB_PASSWORD in your .env (next to docker-compose.yml) and run " +
        "`docker compose up -d` again.",
    };
  }
  return {
    action: "warn",
    message: "WARNING: Using default DB_PASSWORD. Set a secure password via .env for production.",
  };
}
