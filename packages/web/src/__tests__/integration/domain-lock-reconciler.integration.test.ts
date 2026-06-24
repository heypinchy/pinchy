// Real-Postgres integration test for the pre-boot Secure-cookie reconciler.
// Exercises the EXACT reader the entrypoint runner uses against a real
// `settings` table, so a column rename or a change in how `domain` is stored
// fails here instead of silently shipping non-Secure cookies to production.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { readDomainSetting } from "../../../scripts/lib/domain-setting-reader.mjs";
import {
  reconcileDomainLockFlag,
  domainLockFlagPath,
} from "../../../scripts/lib/domain-lock-reconciler.mjs";

const DB_URL = process.env.DATABASE_URL!; // vitest.integration.config.ts sets this

async function withSql<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function setDomainRow(value: string | null, encrypted = false): Promise<void> {
  await withSql(async (sql) => {
    await sql`DELETE FROM settings WHERE key = 'domain'`;
    if (value !== null) {
      await sql`INSERT INTO settings (key, value, encrypted) VALUES ('domain', ${value}, ${encrypted})`;
    }
  });
}

describe("domain-lock reconciler (real Postgres)", () => {
  let secretsDir: string;

  beforeEach(() => {
    secretsDir = mkdtempSync(join(tmpdir(), "pinchy-domain-lock-int-"));
  });

  afterEach(async () => {
    rmSync(secretsDir, { recursive: true, force: true });
    await setDomainRow(null);
  });

  it("reads a locked domain and writes the Secure-cookie flag", async () => {
    await setDomainRow("staging.example.com");

    const domain = await readDomainSetting(DB_URL);
    expect(domain).toBe("staging.example.com");

    const result = reconcileDomainLockFlag({ domain, secretsDir });
    expect(result.locked).toBe(true);
    expect(readFileSync(domainLockFlagPath(secretsDir), "utf8")).toBe("staging.example.com\n");
  });

  it("returns null and removes the flag when no domain is set", async () => {
    await setDomainRow(null);

    const domain = await readDomainSetting(DB_URL);
    expect(domain).toBe(null);

    const result = reconcileDomainLockFlag({ domain, secretsDir });
    expect(result.locked).toBe(false);
    expect(existsSync(domainLockFlagPath(secretsDir))).toBe(false);
  });

  it("ignores an unexpectedly-encrypted domain row (degrades to insecure)", async () => {
    // `domain` is always stored plaintext (setSetting default encrypted=false).
    // If a row is somehow flagged encrypted, the pre-boot reader cannot decrypt
    // it, so it must report not-locked rather than write ciphertext as a domain.
    await setDomainRow("Z0FBQUFBQk...ciphertext", true);

    const domain = await readDomainSetting(DB_URL);
    expect(domain).toBe(null);
  });
});
