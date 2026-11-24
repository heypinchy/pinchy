import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const existsSyncMock = vi.fn(() => false);
  const readFileSyncMock = vi.fn();
  const writeFileSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncMock,
      readFileSync: readFileSyncMock,
      writeFileSync: writeFileSyncMock,
    },
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
  };
});

import { existsSync, readFileSync } from "fs";
import { getSecretSource, isSecretEnvIgnored } from "@/lib/encryption";
import {
  getAuthSecretSource,
  getDbPasswordSource,
  getSecretsProvenance,
  evaluateDbPasswordPolicy,
  evaluateAuditSecretRotation,
  AUDIT_KEY_SWITCH_BACK_DOCS_URL,
  AUDIT_KEY_SWITCH_DOCS_URL,
  describeAuditKeyFilePersist,
  describeIgnoredSecretEnv,
  KEY_VARIABLE_IGNORED_DOCS_URL,
} from "@/lib/secret-source";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const VALID_KEY = "a".repeat(64);

describe("getSecretSource", () => {
  beforeEach(() => {
    mockedExistsSync.mockReturnValue(false);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 'envvar' when the env var holds a valid 64-hex key", () => {
    vi.stubEnv("ENCRYPTION_KEY", VALID_KEY);
    expect(getSecretSource("encryption_key")).toBe("envvar");
  });

  it("falls through to 'file' when the env var is set but invalid", () => {
    vi.stubEnv("ENCRYPTION_KEY", "not-a-valid-key");
    mockedExistsSync.mockImplementation((p) => String(p).endsWith(".encryption_key"));
    expect(getSecretSource("encryption_key")).toBe("file");
  });

  it("returns 'file' when no env var is set and the key file exists", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    mockedExistsSync.mockImplementation((p) => String(p).endsWith(".encryption_key"));
    expect(getSecretSource("encryption_key")).toBe("file");
  });

  it("returns 'unset' when neither env var nor file is present", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(getSecretSource("encryption_key")).toBe("unset");
  });

  it("resolves per-secret names (audit_hmac_secret)", () => {
    vi.stubEnv("AUDIT_HMAC_SECRET", VALID_KEY);
    expect(getSecretSource("audit_hmac_secret")).toBe("envvar");
  });
});

describe("isSecretEnvIgnored", () => {
  // getSecretSource falls through to the key file when the variable is set but
  // not a valid key. That fallback is right, but it was silent: an operator
  // with a 63-character value or a 0x prefix believed the variable was the key.
  afterEach(() => vi.unstubAllEnvs());

  it("is true for a value that is set but not 64 hex characters", () => {
    vi.stubEnv("AUDIT_HMAC_SECRET", "a".repeat(63));
    expect(isSecretEnvIgnored("audit_hmac_secret")).toBe(true);
  });

  it("is true for a hex key with a 0x prefix", () => {
    vi.stubEnv("AUDIT_HMAC_SECRET", `0x${VALID_KEY}`);
    expect(isSecretEnvIgnored("audit_hmac_secret")).toBe(true);
  });

  it("is true for 64 characters that are not all hex", () => {
    vi.stubEnv("ENCRYPTION_KEY", "g".repeat(64));
    expect(isSecretEnvIgnored("encryption_key")).toBe(true);
  });

  it("is false for a valid key", () => {
    vi.stubEnv("AUDIT_HMAC_SECRET", VALID_KEY);
    expect(isSecretEnvIgnored("audit_hmac_secret")).toBe(false);
  });

  it("is false when the variable is empty: unset is a supported choice, not a mistake", () => {
    // docker-compose.yml passes `AUDIT_HMAC_SECRET=${AUDIT_HMAC_SECRET:-}`, so
    // an install that never set it sees an empty string, not an absent one.
    vi.stubEnv("AUDIT_HMAC_SECRET", "");
    expect(isSecretEnvIgnored("audit_hmac_secret")).toBe(false);
  });

  it("agrees with getSecretSource: ignored exactly when a set value is not the source", () => {
    mockedExistsSync.mockReturnValue(false);
    for (const value of ["a".repeat(63), `0x${VALID_KEY}`, VALID_KEY, ` ${VALID_KEY}`]) {
      vi.stubEnv("AUDIT_HMAC_SECRET", value);
      expect(isSecretEnvIgnored("audit_hmac_secret")).toBe(
        getSecretSource("audit_hmac_secret") !== "envvar"
      );
    }
  });
});

describe("describeIgnoredSecretEnv", () => {
  it("warns, naming the variable, that it is ignored and the key file is used", () => {
    const result = describeIgnoredSecretEnv({ envVar: "AUDIT_HMAC_SECRET", ignored: true });

    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/^WARNING: AUDIT_HMAC_SECRET is set but is not a valid key/);
    expect(result.message).toMatch(/ignores it/);
    expect(result.message).toMatch(/key file in the secrets volume instead/);
  });

  it("says what a valid value looks like", () => {
    for (const envVar of ["ENCRYPTION_KEY", "AUDIT_HMAC_SECRET"] as const) {
      const result = describeIgnoredSecretEnv({ envVar, ignored: true });

      expect(result.message).toMatch(
        new RegExp(`^WARNING: ${envVar} is set but is not a valid key`)
      );
      expect(result.message).toMatch(/64 hex characters/);
      expect(result.message).toMatch(/0x/);
    }
  });

  it("doesn't name quotes as something that makes a value invalid", () => {
    // Compose strips surrounding quotes (and a trailing CR or spaces) from a
    // .env value before Pinchy sees it, so quotes never make a key invalid.
    // Naming them sends the operator after a cause that isn't theirs.
    for (const envVar of ["ENCRYPTION_KEY", "AUDIT_HMAC_SECRET"] as const) {
      expect(describeIgnoredSecretEnv({ envVar, ignored: true }).message).not.toMatch(/quote/i);
    }
  });

  it("tells the audit operator whose variable used to work to set it back, not to make a new key", () => {
    // A variable that was a working key and broke later has silently switched
    // Pinchy back to the key file. A fresh key would leave everything the
    // original value signed unverifiable; the original value brings it back.
    const result = describeIgnoredSecretEnv({ envVar: "AUDIT_HMAC_SECRET", ignored: true });
    expect(result.message).toMatch(/held a working key/);
    expect(result.message).toMatch(/set it back to that exact value/);
    expect(result.message).toContain(KEY_VARIABLE_IGNORED_DOCS_URL);
  });

  it("tells the audit operator how to make a fresh key, and that a valid value is a key switch", () => {
    // A valid value replaces the key file as the signing key. That is the
    // supported key switch, but it has a procedure (current key in the file
    // first; several instances stop together), so the warning links to it
    // instead of saying "fix it and restart".
    const result = describeIgnoredSecretEnv({ envVar: "AUDIT_HMAC_SECRET", ignored: true });
    expect(result.message).toMatch(/openssl rand -hex 32/);
    expect(result.message).toMatch(/switches the (audit )?signing key/);
    expect(result.message).toContain(AUDIT_KEY_SWITCH_DOCS_URL);
    expect(result.message).toMatch(/several instances/);
    expect(result.message).toMatch(/stop (them )?all/);
  });

  describe("for ENCRYPTION_KEY", () => {
    // While the variable is ignored, everything Pinchy encrypts goes under the
    // key file. "Fix the value and restart" therefore means "switch the key",
    // and every stored credential stops decrypting (reproduced on PR #1239's
    // review). The only safe moves keep the key file's key in effect.
    const message = () =>
      describeIgnoredSecretEnv({ envVar: "ENCRYPTION_KEY", ignored: true }).message ?? "";

    it("says the key file is the key in use", () => {
      expect(message()).toMatch(/\.encryption_key/);
      expect(message()).toMatch(/is the key Pinchy encrypts .* with now/);
    });

    it("never advises fixing the value", () => {
      expect(message()).not.toMatch(/fix the value/i);
      expect(message()).not.toMatch(/correct the value/i);
    });

    it("never suggests generating a new key", () => {
      expect(message()).not.toMatch(/openssl rand/);
    });

    it("names both safe fixes", () => {
      expect(message()).toMatch(/remov(e|ing) ENCRYPTION_KEY from your \.env/);
      expect(message()).toMatch(/key file's exact contents/);
    });

    it("says what any other value costs", () => {
      expect(message()).toMatch(/any other value/i);
      expect(message()).toMatch(/unreadable/);
    });

    it("tells the operator whose variable used to work to set it back, not to keep the key file", () => {
      // A variable that was a working key and broke later (a character lost
      // in a .env edit) encrypted almost every credential with the original
      // value; only the ones saved while it was broken use the key file. The
      // two safe fixes above would keep the smaller share and lose the rest.
      expect(message()).toMatch(/held a working key/);
      expect(message()).toMatch(/set it back to that exact value/);
      expect(message()).toMatch(/saved while it was broken .*re-enter/);
    });

    it("says how to apply the change so .env is read again", () => {
      // docker compose restart keeps the old environment.
      expect(message()).toMatch(/docker compose up -d/);
      expect(message()).not.toMatch(/docker compose restart/);
    });

    it("links to the docs section with the safe steps", () => {
      expect(message()).toContain(KEY_VARIABLE_IGNORED_DOCS_URL);
    });
  });

  it("tells the audit operator not to remove the key file while the variable is ignored", () => {
    // While the variable is ignored the file IS the signing key. Removing it,
    // as the retire-the-earlier-key steps describe, would make Pinchy generate
    // a new random key at the next audit entry.
    const result = describeIgnoredSecretEnv({ envVar: "AUDIT_HMAC_SECRET", ignored: true });
    expect(result.message).toMatch(/don't remove \.audit_hmac_secret/);
  });

  it("is silent when the variable is not ignored", () => {
    expect(describeIgnoredSecretEnv({ envVar: "AUDIT_HMAC_SECRET", ignored: false })).toEqual({
      action: "none",
    });
  });

  it("never carries the value", () => {
    // Takes a boolean, not the value, so the value cannot reach the log; this
    // pins that no key-shaped text does either.
    for (const envVar of ["ENCRYPTION_KEY", "AUDIT_HMAC_SECRET"] as const) {
      const result = describeIgnoredSecretEnv({ envVar, ignored: true });
      expect(result.message).not.toMatch(/[0-9a-f]{16}/i);
    }
  });
});

describe("getAuthSecretSource", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 'envvar' when BETTER_AUTH_SECRET is set", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "some-long-secret-value");
    expect(getAuthSecretSource()).toBe("envvar");
  });

  it("returns 'file' when the preload loaded the secret from the secrets volume", () => {
    // server-preload.cjs copies the file-backed secret into the env and marks
    // the provenance — without the marker we could not tell the sources apart.
    vi.stubEnv("BETTER_AUTH_SECRET", "loaded-from-file");
    vi.stubEnv("PINCHY_AUTH_SECRET_SOURCE", "file");
    expect(getAuthSecretSource()).toBe("file");
  });

  it("returns 'unset' when BETTER_AUTH_SECRET is empty or whitespace", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(getAuthSecretSource()).toBe("unset");
    vi.stubEnv("BETTER_AUTH_SECRET", "   ");
    expect(getAuthSecretSource()).toBe("unset");
  });
});

describe("getDbPasswordSource", () => {
  beforeEach(() => {
    mockedExistsSync.mockReturnValue(false);
  });

  it("returns 'default' when the URL carries the default dev password", () => {
    expect(getDbPasswordSource("postgresql://pinchy:pinchy_dev@db:5432/pinchy")).toBe("default");
  });

  it("returns 'custom' for any other password", () => {
    expect(getDbPasswordSource("postgresql://pinchy:s3cure-pw@db:5432/pinchy")).toBe("custom");
  });

  it("returns 'generated' when the URL password matches the persisted .db_password file", () => {
    const generated = "c".repeat(64);
    mockedExistsSync.mockImplementation((p) => String(p).endsWith(".db_password"));
    mockedReadFileSync.mockReturnValue(`${generated}\n`);
    expect(getDbPasswordSource(`postgresql://pinchy:${generated}@db:5432/pinchy`)).toBe(
      "generated"
    );
  });

  it("returns 'custom' when the URL password differs from the persisted file", () => {
    mockedExistsSync.mockImplementation((p) => String(p).endsWith(".db_password"));
    mockedReadFileSync.mockReturnValue(`${"c".repeat(64)}\n`);
    expect(getDbPasswordSource("postgresql://pinchy:operator-pw@db:5432/pinchy")).toBe("custom");
  });
});

describe("getSecretsProvenance", () => {
  beforeEach(() => {
    mockedExistsSync.mockReturnValue(false);
    vi.unstubAllEnvs();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reports provenance for all four secrets with issue-#156 keys", () => {
    vi.stubEnv("ENCRYPTION_KEY", VALID_KEY);
    vi.stubEnv("BETTER_AUTH_SECRET", "auth-secret");
    vi.stubEnv("DATABASE_URL", "postgresql://pinchy:pinchy_dev@db:5432/pinchy");

    expect(getSecretsProvenance()).toEqual({
      encryption_key: "envvar",
      auth_secret: "envvar",
      audit_hmac_secret: "unset",
      db_password: "default",
    });
  });
});

describe("evaluateDbPasswordPolicy", () => {
  const DEFAULT_URL = "postgresql://pinchy:pinchy_dev@db:5432/pinchy";
  const CUSTOM_URL = "postgresql://pinchy:s3cure-pw@db:5432/pinchy";

  beforeEach(() => {
    mockedExistsSync.mockReturnValue(false);
  });

  // Deliberately warn-only: the entrypoint's auto-migration (issue #156,
  // scripts/resolve-db-password.mjs) moves installs off the default password
  // automatically. Reaching the server with the default URL means that
  // migration failed or was skipped — warn loudly, never refuse to start.
  it("warns loudly in production when the default password survived boot resolution", () => {
    const result = evaluateDbPasswordPolicy({
      nodeEnv: "production",
      databaseUrl: DEFAULT_URL,
    });
    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/DB_PASSWORD/);
    expect(result.message).toMatch(/migration/i);
  });

  it("warns outside production with the default password", () => {
    const result = evaluateDbPasswordPolicy({
      nodeEnv: "development",
      databaseUrl: DEFAULT_URL,
    });
    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/DB_PASSWORD/);
  });

  it("is silent with a custom password", () => {
    expect(
      evaluateDbPasswordPolicy({ nodeEnv: "production", databaseUrl: CUSTOM_URL }).action
    ).toBe("none");
    expect(
      evaluateDbPasswordPolicy({ nodeEnv: "development", databaseUrl: CUSTOM_URL }).action
    ).toBe("none");
  });

  it("is silent with an auto-generated password", () => {
    const generated = "c".repeat(64);
    mockedExistsSync.mockImplementation((p) => String(p).endsWith(".db_password"));
    mockedReadFileSync.mockReturnValue(generated);
    expect(
      evaluateDbPasswordPolicy({
        nodeEnv: "production",
        databaseUrl: `postgresql://pinchy:${generated}@db:5432/pinchy`,
      }).action
    ).toBe("none");
  });
});

describe("evaluateAuditSecretRotation", () => {
  // Pinning AUDIT_HMAC_SECRET over a secret Pinchy generated leaves the log
  // signed under two keys. verifyIntegrity handles it, but only when somebody
  // clicks "Verify Integrity" — and the periodic sweep sees the pre-rotation
  // rows only if the checkpoint happened to lag the tip when the key changed.
  // On a quiet instance it never reports the rotation at all. So the state has
  // to announce itself at startup, the same way #156 announces the database
  // password: warn loudly, never refuse to start.
  it("warns when the environment variable superseded a generated secret", () => {
    const result = evaluateAuditSecretRotation({ hasSupersededSecret: true });

    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/AUDIT_HMAC_SECRET/);
    // The two facts an operator has to act on: older rows are fine, and the
    // volume holding the key that proves it must stay backed up.
    expect(result.message).toMatch(/not.*tamper|tamper.*not/i);
    expect(result.message).toMatch(/pinchy-secrets/);
  });

  it("does not offer switching back as a free undo", () => {
    // The previous key Pinchy verifies against is always the key FILE. Switch
    // back to it and the rows signed with the variable's value verify under no
    // key; pin the variable again later and the file-key rows written in
    // between sit after new-key rows, which is what a forgery looks like. A
    // notice that says "remove it and restart" steers operators straight into
    // that, so it names the cost and points at the section that explains it.
    const result = evaluateAuditSecretRotation({ hasSupersededSecret: true });

    expect(result.message).not.toMatch(/remove AUDIT_HMAC_SECRET from your \.env and restart\.$/);
    expect(result.message).toMatch(/for good/);
    // The key file may hold an earlier AUDIT_HMAC_SECRET value Pinchy saved
    // there, not a generated key; "the generated key" would send an operator
    // who never had one looking for it.
    expect(result.message).toMatch(/stay on the key in the file for good/);
    expect(result.message).not.toMatch(/generated key/);
    expect(result.message).toContain(AUDIT_KEY_SWITCH_BACK_DOCS_URL);
  });

  it("is silent when nothing was superseded", () => {
    expect(evaluateAuditSecretRotation({ hasSupersededSecret: false })).toEqual({
      action: "none",
    });
  });

  it("never puts a key value in the message", () => {
    // #156's rule for this whole module: surface WHERE a secret comes from,
    // never its value. The policy takes a boolean precisely so no key can
    // reach it, and this pins that signature.
    const result = evaluateAuditSecretRotation({ hasSupersededSecret: true });
    expect(result.message).not.toMatch(/[0-9a-f]{32}/i);
  });
});

describe("describeAuditKeyFilePersist", () => {
  // The startup step that writes a variable-only AUDIT_HMAC_SECRET into the
  // key file says what it did, once, and never the key. A failed write is
  // logged as a warning and startup continues — but the warning must say what
  // that costs, or "fail open" quietly becomes "fail silent".
  it("announces a written key file without the key", () => {
    const result = describeAuditKeyFilePersist({ status: "written", dir: "/app/secrets" });

    expect(result.action).toBe("info");
    expect(result.message).toMatch(/AUDIT_HMAC_SECRET/);
    expect(result.message).toMatch(/\.audit_hmac_secret/);
    expect(result.message).not.toMatch(/[0-9a-f]{32}/i);
  });

  it("says the saved key only outlasts a change of the variable on a persistent volume", () => {
    // The file only keeps the key if its directory survives a container being
    // recreated. Promising that "a later change keeps this key" without the
    // condition is a promise an ephemeral directory silently breaks.
    const result = describeAuditKeyFilePersist({ status: "written", dir: "/app/secrets" });

    expect(result.message).toMatch(/\/app\/secrets/);
    expect(result.message).toMatch(/persistent volume/);
  });

  it("names the directory the key was actually written to, not the default", () => {
    // ENCRYPTION_KEY_DIR moves the key files. Telling the operator to keep
    // /app/secrets on a persistent volume when the key sits elsewhere sends
    // them to protect the wrong directory.
    const result = describeAuditKeyFilePersist({ status: "written", dir: "/srv/pinchy/keys" });

    expect(result.message).toContain("/srv/pinchy/keys");
    expect(result.message).not.toMatch(/\/app\/secrets/);
  });

  it("warns on a failed write, names the reason and the consequence, and does not stop startup", () => {
    const result = describeAuditKeyFilePersist({
      status: "failed",
      reason: "EACCES: permission denied, open '/app/secrets/.audit_hmac_secret.tmp'",
    });

    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/EACCES/);
    expect(result.message).toMatch(/continu/i);
    // What a later switch of the variable then loses.
    expect(result.message).toMatch(/switch/i);
  });

  it("warns when the existing key file is not a valid key, says what that costs, and never prints it", () => {
    // The file is left alone (never overwrite), so the current value is not
    // saved anywhere. Silent, that reads exactly like a healthy key file.
    const result = describeAuditKeyFilePersist({ status: "file-invalid" });

    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/\.audit_hmac_secret/);
    expect(result.message).toMatch(/not a valid key/);
    expect(result.message).toMatch(/not saved/);
    expect(result.message).toMatch(/move it aside/i);
    expect(result.message).toMatch(/restart Pinchy/);
    expect(result.message).toContain(AUDIT_KEY_SWITCH_DOCS_URL);
  });

  it("warns when the existing key file cannot be read, and points at its owner instead of moving it", () => {
    // A key file restored from a backup as root reads as EACCES. It can be the
    // earlier key, the only one that verifies what it signed, so the advice
    // for an invalid file (move it aside) would make the operator discard it.
    const result = describeAuditKeyFilePersist({ status: "file-unreadable", code: "EACCES" });

    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/\.audit_hmac_secret/);
    expect(result.message).toMatch(/EACCES/);
    expect(result.message).toMatch(/not saved/);
    expect(result.message).toMatch(/owner and permissions/);
    // Dockerfile.pinchy: useradd -u 999; the entrypoint starts the server as it.
    expect(result.message).toMatch(/uid 999/);
    expect(result.message).not.toMatch(/move it aside/i);
    expect(result.message).not.toMatch(/not a valid key/);
    expect(result.message).toContain(AUDIT_KEY_SWITCH_DOCS_URL);
  });

  it("names the code for an unreadable key file that is not a permissions problem", () => {
    const result = describeAuditKeyFilePersist({ status: "file-unreadable", code: "EISDIR" });

    expect(result.action).toBe("warn");
    expect(result.message).toMatch(/EISDIR/);
  });

  it("is silent when the file already exists or the variable is not in use", () => {
    expect(describeAuditKeyFilePersist({ status: "file-exists" })).toEqual({ action: "none" });
    expect(describeAuditKeyFilePersist({ status: "not-envvar" })).toEqual({ action: "none" });
  });
});
