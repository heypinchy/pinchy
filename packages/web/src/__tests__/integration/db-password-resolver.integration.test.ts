// Real-Postgres integration test for the DB password auto-migration (#156).
// Uses the EXACT deps the entrypoint runner uses (db-password-deps.mjs), so a
// behaviour change in probe/ALTER USER wiring fails here, not in production.
//
// The test creates its own login role so the suite's primary user (and the
// other integration tests) are never affected.
import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  resolveDbPassword,
  replaceUrlPassword,
  DB_PASSWORD_FILE,
} from "../../../scripts/lib/db-password-resolver.mjs";
import { createDbPasswordDeps } from "../../../scripts/lib/db-password-deps.mjs";

const ADMIN_URL = process.env.DATABASE_URL!; // vitest.integration.config.ts sets this
const ROLE = "pinchy_migtest";
const DEFAULT_PW = "pinchy_dev";

function roleUrl(password: string): string {
  const url = new URL(ADMIN_URL);
  url.username = ROLE;
  url.password = password;
  return url.toString();
}

async function adminSql<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe("db password resolver (real Postgres)", () => {
  let secretsDir: string;
  const deps = createDbPasswordDeps();

  beforeAll(async () => {
    await adminSql(async (sql) => {
      await sql.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
      await sql.unsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${DEFAULT_PW}'`);
    });
  });

  beforeEach(async () => {
    secretsDir = mkdtempSync(join(tmpdir(), "pinchy-dbpw-"));
    // Reset the role to the default password before each scenario.
    await adminSql((sql) => sql.unsafe(`ALTER ROLE ${ROLE} WITH PASSWORD '${DEFAULT_PW}'`));
  });

  afterAll(async () => {
    await adminSql((sql) => sql.unsafe(`DROP ROLE IF EXISTS ${ROLE}`));
    rmSync(secretsDir, { recursive: true, force: true });
  });

  it("migrates a default-password role end to end and is idempotent", async () => {
    const defaultUrl = roleUrl(DEFAULT_PW);

    // First boot: generate + persist + ALTER USER.
    const first = await resolveDbPassword({ databaseUrl: defaultUrl, secretsDir, deps });
    expect(first.source).toBe("generated");
    expect(first.migrated).toBe(true);

    const persisted = readFileSync(join(secretsDir, DB_PASSWORD_FILE), "utf-8").trim();
    expect(persisted).toMatch(/^[0-9a-f]{64}$/);

    // The new password really is live: it connects, the default doesn't.
    expect(await deps.probe(first.url)).toBe(true);
    expect(await deps.probe(defaultUrl)).toBe(false);

    // Second boot (steady state): same URL, no further migration.
    const second = await resolveDbPassword({ databaseUrl: defaultUrl, secretsDir, deps });
    expect(second.source).toBe("generated");
    expect(second.migrated).toBeUndefined();
    expect(second.url).toBe(first.url);
  });

  it("recovers when the file was persisted but ALTER USER never ran (crash window)", async () => {
    const defaultUrl = roleUrl(DEFAULT_PW);
    const orphanPassword = "ab".repeat(32);
    writeFileSync(join(secretsDir, DB_PASSWORD_FILE), orphanPassword, { mode: 0o600 });

    const result = await resolveDbPassword({ databaseUrl: defaultUrl, secretsDir, deps });
    expect(result.source).toBe("generated");
    expect(result.migrated).toBe(true);
    expect(await deps.probe(roleUrl(orphanPassword))).toBe(true);
    expect(await deps.probe(defaultUrl)).toBe(false);
  });

  it("applies an explicit DB_PASSWORD when the role still runs on the default (forgotten ALTER USER)", async () => {
    const operatorUrl = roleUrl("operator-chosen-pw");

    const result = await resolveDbPassword({ databaseUrl: operatorUrl, secretsDir, deps });
    expect(result.source).toBe("custom");
    expect(result.migrated).toBe(true);
    expect(await deps.probe(operatorUrl)).toBe(true);
    expect(await deps.probe(roleUrl(DEFAULT_PW))).toBe(false);
  });

  it("switches from a generated password to a later explicit DB_PASSWORD and removes the file", async () => {
    const defaultUrl = roleUrl(DEFAULT_PW);
    await resolveDbPassword({ databaseUrl: defaultUrl, secretsDir, deps });
    expect(existsSync(join(secretsDir, DB_PASSWORD_FILE))).toBe(true);

    // Operator later pins DB_PASSWORD in .env; the db still runs on the
    // generated one. The resolver heals the mismatch and drops the file.
    const operatorUrl = roleUrl("operator-chosen-pw");
    const result = await resolveDbPassword({ databaseUrl: operatorUrl, secretsDir, deps });
    expect(result.source).toBe("custom");
    expect(result.migrated).toBe(true);
    expect(await deps.probe(operatorUrl)).toBe(true);
    expect(existsSync(join(secretsDir, DB_PASSWORD_FILE))).toBe(false);
  });

  it("quotes passwords with SQL metacharacters safely", async () => {
    const trickyUrl = replaceUrlPassword(roleUrl("x"), "it's;DROP TABLE--\"quote");

    const result = await resolveDbPassword({ databaseUrl: trickyUrl, secretsDir, deps });
    expect(result.source).toBe("custom");
    expect(result.migrated).toBe(true);
    expect(await deps.probe(trickyUrl)).toBe(true);
  });
});
