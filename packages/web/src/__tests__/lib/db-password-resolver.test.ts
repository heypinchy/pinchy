// Unit tests for the boot-time DB password auto-migration (#156).
// The resolver lives in scripts/lib as plain .mjs because entrypoint.sh runs
// it with plain `node` before drizzle-kit and the server start — no tsx, no
// path aliases. Tests inject fake deps; the real postgres/fs deps are
// exercised by db-password-resolver.integration.test.ts.
import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_DB_PASSWORD,
  replaceUrlPassword,
  generateDbPassword,
  resolveDbPassword,
} from "../../../scripts/lib/db-password-resolver.mjs";

const DEFAULT_URL = `postgresql://pinchy:${DEFAULT_DB_PASSWORD}@db:5432/pinchy`;
const CUSTOM_URL = "postgresql://pinchy:operator-pw@db:5432/pinchy";
const SECRETS_DIR = "/app/secrets";
const FILE_PATH = "/app/secrets/.db_password";
const FILE_PW = "f".repeat(64);

interface FakeDepsOptions {
  probeOk?: (url: string) => boolean;
  files?: Record<string, string>;
  writeError?: Error;
  alterError?: Error;
}

function fakeDeps(opts: FakeDepsOptions = {}) {
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const calls: string[] = [];
  return {
    files,
    calls,
    deps: {
      probe: vi.fn(async (url: string) => (opts.probeOk ? opts.probeOk(url) : false)),
      alterPassword: vi.fn(async (_url: string, _user: string, _pw: string) => {
        calls.push("alter");
        if (opts.alterError) throw opts.alterError;
      }),
      readFile: vi.fn((path: string) => files[path] ?? null),
      writeFile: vi.fn((path: string, content: string) => {
        calls.push("write");
        if (opts.writeError) throw opts.writeError;
        files[path] = content;
      }),
      deleteFile: vi.fn((path: string) => {
        delete files[path];
      }),
      log: vi.fn(),
    },
  };
}

describe("replaceUrlPassword", () => {
  it("replaces only the password, keeping user, host, port, db, and query", () => {
    const url = "postgresql://pinchy:old@db:5432/pinchy?sslmode=disable";
    const out = replaceUrlPassword(url, "newpw");
    expect(out).toContain("pinchy:newpw@db:5432/pinchy");
    expect(out).toContain("sslmode=disable");
    expect(out).not.toContain("old");
  });
});

describe("generateDbPassword", () => {
  it("produces 64 hex characters", () => {
    expect(generateDbPassword()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveDbPassword", () => {
  it("returns the URL untouched when a custom password connects", async () => {
    const { deps } = fakeDeps({ probeOk: (u) => u === CUSTOM_URL });
    const result = await resolveDbPassword({
      databaseUrl: CUSTOM_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result).toMatchObject({ url: CUSTOM_URL, source: "custom" });
    expect(deps.alterPassword).not.toHaveBeenCalled();
  });

  it("heals a custom password the operator set without ALTER USER (db still on default)", async () => {
    const { deps } = fakeDeps({
      probeOk: (u) => u.includes(`:${DEFAULT_DB_PASSWORD}@`),
    });
    const result = await resolveDbPassword({
      databaseUrl: CUSTOM_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result).toMatchObject({ url: CUSTOM_URL, source: "custom", migrated: true });
    expect(deps.alterPassword).toHaveBeenCalledWith(
      expect.stringContaining(`:${DEFAULT_DB_PASSWORD}@`),
      "pinchy",
      "operator-pw"
    );
  });

  it("heals a custom password when the db runs on a previously generated one, and removes the stale file", async () => {
    const { deps, files } = fakeDeps({
      probeOk: (u) => u.includes(`:${FILE_PW}@`),
      files: { [FILE_PATH]: FILE_PW },
    });
    const result = await resolveDbPassword({
      databaseUrl: CUSTOM_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result).toMatchObject({ url: CUSTOM_URL, source: "custom", migrated: true });
    expect(deps.alterPassword).toHaveBeenCalledWith(
      expect.stringContaining(`:${FILE_PW}@`),
      "pinchy",
      "operator-pw"
    );
    expect(files[FILE_PATH]).toBeUndefined();
  });

  it("returns a warning when a custom password matches nothing", async () => {
    const { deps } = fakeDeps({ probeOk: () => false });
    const result = await resolveDbPassword({
      databaseUrl: CUSTOM_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result.url).toBe(CUSTOM_URL);
    expect(result.source).toBe("custom");
    expect(result.warning).toBeTruthy();
    expect(deps.alterPassword).not.toHaveBeenCalled();
  });

  it("migrates a default-password install: generate, persist, then ALTER USER", async () => {
    const { deps, files, calls } = fakeDeps({
      probeOk: (u) => u.includes(`:${DEFAULT_DB_PASSWORD}@`),
    });
    const result = await resolveDbPassword({
      databaseUrl: DEFAULT_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result.source).toBe("generated");
    expect(result.migrated).toBe(true);
    const persisted = files[FILE_PATH];
    expect(persisted).toMatch(/^[0-9a-f]{64}$/);
    expect(result.url).toContain(`:${persisted}@`);
    // Crash safety: the file must be persisted BEFORE the password changes.
    expect(calls).toEqual(["write", "alter"]);
  });

  it("keeps the default password (with a warning) when the secrets dir is not writable", async () => {
    const { deps } = fakeDeps({
      probeOk: (u) => u.includes(`:${DEFAULT_DB_PASSWORD}@`),
      writeError: new Error("EROFS: read-only file system"),
    });
    const result = await resolveDbPassword({
      databaseUrl: DEFAULT_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result).toMatchObject({ url: DEFAULT_URL, source: "default" });
    expect(result.warning).toMatch(/EROFS/);
    expect(deps.alterPassword).not.toHaveBeenCalled();
  });

  it("keeps the default URL (with a warning) when the database is unreachable", async () => {
    const { deps } = fakeDeps({ probeOk: () => false });
    const result = await resolveDbPassword({
      databaseUrl: DEFAULT_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result).toMatchObject({ url: DEFAULT_URL, source: "default" });
    expect(result.warning).toBeTruthy();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.alterPassword).not.toHaveBeenCalled();
  });

  it("uses the persisted password without ALTER USER on subsequent boots (steady state)", async () => {
    const { deps } = fakeDeps({
      probeOk: (u) => u.includes(`:${FILE_PW}@`),
      files: { [FILE_PATH]: FILE_PW },
    });
    const result = await resolveDbPassword({
      databaseUrl: DEFAULT_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result.source).toBe("generated");
    expect(result.url).toContain(`:${FILE_PW}@`);
    expect(result.migrated).toBeUndefined();
    expect(deps.alterPassword).not.toHaveBeenCalled();
  });

  it("recovers from a crash between persist and ALTER USER", async () => {
    // File exists but the db still accepts the default password.
    const { deps } = fakeDeps({
      probeOk: (u) => u.includes(`:${DEFAULT_DB_PASSWORD}@`),
      files: { [FILE_PATH]: FILE_PW },
    });
    const result = await resolveDbPassword({
      databaseUrl: DEFAULT_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result.source).toBe("generated");
    expect(result.migrated).toBe(true);
    expect(result.url).toContain(`:${FILE_PW}@`);
    expect(deps.alterPassword).toHaveBeenCalledWith(
      expect.stringContaining(`:${DEFAULT_DB_PASSWORD}@`),
      "pinchy",
      FILE_PW
    );
  });

  it("leaves the persisted file in place when ALTER USER fails, so the next boot can recover", async () => {
    const { deps, files } = fakeDeps({
      probeOk: (u) => u.includes(`:${DEFAULT_DB_PASSWORD}@`),
      alterError: new Error("connection lost"),
    });
    const result = await resolveDbPassword({
      databaseUrl: DEFAULT_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result).toMatchObject({ url: DEFAULT_URL, source: "default" });
    expect(result.warning).toMatch(/connection lost/);
    expect(files[FILE_PATH]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a warning when neither the persisted nor the default password connects", async () => {
    const { deps } = fakeDeps({
      probeOk: () => false,
      files: { [FILE_PATH]: FILE_PW },
    });
    const result = await resolveDbPassword({
      databaseUrl: DEFAULT_URL,
      secretsDir: SECRETS_DIR,
      deps,
    });
    expect(result).toMatchObject({ url: DEFAULT_URL, source: "default" });
    expect(result.warning).toBeTruthy();
    expect(deps.alterPassword).not.toHaveBeenCalled();
  });
});
