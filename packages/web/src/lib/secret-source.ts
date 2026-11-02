// Issue #156: surface WHERE each secret comes from — never its value.
//
// `docker inspect` shows env vars as empty strings when only the file
// fallback is active (auto-generated secret under /app/secrets). That made
// an operator misread "no secret" and rotate secrets that didn't need
// rotating, losing encrypted data. Provenance makes the file fallback
// visible from outside the container.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getSecretSource, type SecretSource, type EnvSecretPersistOutcome } from "@/lib/encryption";

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

export interface AuditSecretPolicyResult {
  action: "warn" | "none";
  message?: string;
}

/**
 * Where the startup warning sends an operator whose key file could not be
 * written: the one procedure for switching the key. Exported so a docs test
 * can check the heading still exists: the docs anchor check only reads links
 * in the built site, never a URL in a log line.
 */
export const AUDIT_KEY_SWITCH_DOCS_URL =
  "https://docs.heypinchy.com/concepts/audit-trail-verification/#switching-the-key";

/**
 * Where the startup notice sends an operator who did not mean to switch keys.
 * Exported for the same docs test.
 */
export const AUDIT_KEY_SWITCH_BACK_DOCS_URL =
  "https://docs.heypinchy.com/concepts/audit-trail-verification/#switching-back-to-the-earlier-key";

/**
 * Pinning `AUDIT_HMAC_SECRET` over a secret Pinchy generated leaves the audit
 * log signed under two keys. `verifyIntegrity` handles that — rows signed with
 * the superseded key land in `previousKeyIds` instead of `invalidIds` — but
 * only when somebody asks. Nothing announces the state on its own:
 *
 *   - The **admin** sees it when they click "Verify Integrity", which may be
 *     months later and plausibly mid-investigation.
 *   - The **periodic sweep** scans forward from a checkpoint, so it reports the
 *     rotation only for pre-rotation rows that were still above that checkpoint
 *     when the key changed. On an instance that was quiet before the restart,
 *     the checkpoint sits at the tip and no sweep ever reports it.
 *
 * So the state announces itself at startup instead. Same house rule as #156
 * one function up: warn loudly, never refuse to start. A rotation is a
 * documented, supported upgrade step — not a reason to hold an install down.
 *
 * The warning repeats on every boot on purpose. The two-key state is permanent
 * (the log is append-only, so those rows never age out), and so is the thing
 * the operator has to keep doing about it: back up the volume holding the key
 * that proves they are authentic.
 *
 * Takes a boolean, never the key. This module's rule since #156 is to surface
 * WHERE a secret comes from and never its value; a signature that cannot
 * accept a key cannot leak one.
 */
export function evaluateAuditSecretRotation(opts: {
  hasSupersededSecret: boolean;
}): AuditSecretPolicyResult {
  if (!opts.hasSupersededSecret) return { action: "none" };

  // Switching back is not a free undo. The previous key Pinchy verifies against
  // is always the key file, so once the file key is active again, the rows
  // signed with the variable's value verify under no key. Pinning the variable
  // again later is worse: the file-key rows written in between sit after
  // new-key rows, which is exactly what a forgery looks like. So the notice
  // names the cost instead of offering "remove it and restart" as the fix.
  return {
    action: "warn",
    message:
      "NOTICE: AUDIT_HMAC_SECRET is set and differs from the audit signing key " +
      "in the secrets volume. Entries written before the switch are signed with " +
      "the older key — integrity verification reports them as signed with an " +
      "earlier secret, not as tampered. Verifying them depends on that key, so " +
      "keep backing up the pinchy-secrets volume. If you did not mean to change " +
      "the key, keeping the new one is usually the safer choice: switching back " +
      "leaves the entries signed with it unverifiable, and switching forward " +
      "again later breaks verification for everything written in between. " +
      "Switch back only if you then stay on the key in the file for good. See " +
      AUDIT_KEY_SWITCH_BACK_DOCS_URL,
  };
}

export interface IgnoredSecretEnvLog {
  action: "warn" | "none";
  message?: string;
}

/**
 * Where the ignored-`ENCRYPTION_KEY` warning sends an operator: the steps that
 * keep their stored credentials readable. Exported for the same docs test as
 * the audit links above.
 */
export const ENCRYPTION_KEY_IGNORED_DOCS_URL =
  "https://docs.heypinchy.com/reference/environment-variables/#when-pinchy-ignores-a-key-variable";

/**
 * The startup warning for a key variable Pinchy ignores. {@link getSecretSource}
 * only accepts 64 hex characters and otherwise falls back to the key file,
 * which is the right fallback but used to be a silent one: an operator with a
 * 63-character value or a `0x` prefix saw nothing wrong and believed the
 * variable was the key.
 *
 * The remedy differs per variable, because "fix the value and restart" is a
 * key switch for both:
 *
 *   - `ENCRYPTION_KEY`: while the variable is ignored, everything Pinchy
 *     encrypts goes under the key file. A corrected value is a different key,
 *     and every credential stored so far stops decrypting. The only safe moves
 *     keep the file's key in effect: drop the variable, or set it to the
 *     file's exact contents. So this warning never suggests a new key.
 *   - `AUDIT_HMAC_SECRET`: a corrected value switches the signing key, which is
 *     supported but has a procedure (current key in the file first, several
 *     instances stop together). Until then the file is the signing key, and the
 *     retire-the-earlier-key steps remove that file.
 *
 * Takes a boolean, never the value, for the reason
 * {@link evaluateAuditSecretRotation} does. The message says only "not 64 hex
 * characters", never the length or any part of what was set.
 */
export function describeIgnoredSecretEnv(opts: {
  envVar: "ENCRYPTION_KEY" | "AUDIT_HMAC_SECRET";
  ignored: boolean;
}): IgnoredSecretEnvLog {
  if (!opts.ignored) return { action: "none" };

  const ignored =
    `WARNING: ${opts.envVar} is set but is not a valid key, so Pinchy ignores it ` +
    "and uses the key file in the secrets volume instead (creating one there if " +
    "there is none). A valid key is 64 hex characters (0-9, a-f), with no 0x " +
    "prefix, quotes or spaces.";

  if (opts.envVar === "ENCRYPTION_KEY") {
    return {
      action: "warn",
      message:
        `${ignored} That file, .encryption_key, is the key Pinchy encrypts your ` +
        "stored credentials with now. The safe fixes are removing ENCRYPTION_KEY from " +
        "your .env, or setting it to the key file's exact contents, then running " +
        "docker compose up -d. Any other value, even a valid one, makes everything " +
        "encrypted with the key file unreadable, and those credentials can only be " +
        "re-entered. See " +
        ENCRYPTION_KEY_IGNORED_DOCS_URL,
    };
  }

  return {
    action: "warn",
    message:
      `${ignored} Until it is, the key file is the audit signing key, so don't ` +
      "remove .audit_hmac_secret from the volume. Setting a valid value, such as " +
      "the output of openssl rand -hex 32, switches the signing key: follow " +
      `${AUDIT_KEY_SWITCH_DOCS_URL} (on several instances against one database, ` +
      "stop them all first).",
  };
}

export interface AuditKeyFilePersistLog {
  action: "info" | "warn" | "none";
  message?: string;
}

/**
 * The startup log line for {@link persistEnvSecretToKeyFile} on the audit
 * secret. One line when it wrote the file, so the file appearing in the volume
 * is never a mystery; a warning when it could not, because the write is what
 * lets a later switch of the variable keep the old key, and an operator who
 * does not know it failed would switch and lose verification of everything
 * signed so far. The same warning, with the remedy, when an existing key file
 * is not a valid key: Pinchy never overwrites it, so the value is not saved
 * either. A different warning when the file cannot be read at all, because
 * the fix is its owner, not moving it aside. Silent otherwise. Never the key,
 * never the file's content.
 */
export function describeAuditKeyFilePersist(
  outcome: EnvSecretPersistOutcome
): AuditKeyFilePersistLog {
  switch (outcome.status) {
    case "written":
      return {
        action: "info",
        message:
          `Wrote the AUDIT_HMAC_SECRET value to .audit_hmac_secret in ${outcome.dir}. ` +
          "Keep that directory on a persistent volume, so a later change of the " +
          "variable keeps this key for verifying the entries signed with it.",
      };
    case "failed":
      return {
        action: "warn",
        message:
          "WARNING: Could not write the AUDIT_HMAC_SECRET value to " +
          `.audit_hmac_secret (${outcome.reason}). Startup continues and audit ` +
          "entries are signed as usual, but if you switch AUDIT_HMAC_SECRET to a " +
          "new value before this works, the entries signed with the current value " +
          "can't be verified any more. See " +
          AUDIT_KEY_SWITCH_DOCS_URL,
      };
    case "file-invalid":
      // Never overwritten, so this stays until someone looks at it. Named, not
      // printed: whatever is in the file might be the remains of a key.
      return {
        action: "warn",
        message:
          "WARNING: .audit_hmac_secret in the secrets volume is not a valid key " +
          "(expected 64 hex characters), so the current AUDIT_HMAC_SECRET value is " +
          "not saved in it. Pinchy leaves the file as it is and signs audit entries " +
          "as usual, but if you switch AUDIT_HMAC_SECRET to a new value, the entries " +
          "signed with the current value can't be verified any more. Move it aside " +
          "and restart Pinchy; it then writes the current value there. See " +
          AUDIT_KEY_SWITCH_DOCS_URL,
      };
    case "file-unreadable":
      // Not "invalid": a file Pinchy cannot read may be exactly the earlier
      // key, typically restored from a backup as root. Moving it aside, the
      // remedy for an invalid file, would throw a good key away.
      return {
        action: "warn",
        message:
          "WARNING: Could not read .audit_hmac_secret in the secrets volume " +
          `(${outcome.code}), so the current AUDIT_HMAC_SECRET value is not saved ` +
          "in it. Pinchy leaves the file as it is and signs audit entries as usual. " +
          "The file may still hold a key you need, so don't remove it: check the " +
          "file's owner and permissions (Pinchy runs as uid 999 and has to be able " +
          "to read it), make sure it is a file and not a directory, and restart " +
          "Pinchy. Until then, if you switch AUDIT_HMAC_SECRET to a new value, the " +
          "entries signed with the current value can't be verified any more. See " +
          AUDIT_KEY_SWITCH_DOCS_URL,
      };
    default:
      return { action: "none" };
  }
}
