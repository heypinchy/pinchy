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
import { getSecretSource } from "@/lib/encryption";
import {
  getAuthSecretSource,
  getDbPasswordSource,
  getSecretsProvenance,
  evaluateDbPasswordPolicy,
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
