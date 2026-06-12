// Real-world deps for db-password-resolver.mjs — separated so the unit tests
// inject fakes while the integration test and the entrypoint runner share
// these exact implementations.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import postgres from "postgres";

const IDENTIFIER = /^[a-zA-Z0-9_]+$/;

async function withClient(url, fn) {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function createDbPasswordDeps({ log } = {}) {
  const emit = log ?? (() => {});
  return {
    probe: async (url) => {
      try {
        await withClient(url, (sql) => sql`SELECT 1`);
        return true;
      } catch (err) {
        // 28P01 = invalid_password — the expected "wrong candidate" outcome.
        // Anything else (db missing, network refused) is diagnostic gold for
        // a failed migration, so surface it on stderr.
        if (err?.code !== "28P01") {
          emit(`probe failed (${err?.code ?? "?"}): ${err instanceof Error ? err.message : err}`);
        }
        return false;
      }
    },

    alterPassword: async (url, username, newPassword) => {
      if (!IDENTIFIER.test(username)) {
        throw new Error(`refusing to alter unexpected database user "${username}"`);
      }
      await withClient(url, async (sql) => {
        // ALTER USER is a utility statement and cannot take bind parameters.
        // Let the server build the correctly-quoted statement via format()
        // (with ordinary bind parameters), then execute that exact string.
        const [{ statement }] = await sql`
          SELECT format('ALTER USER %I WITH PASSWORD %L', ${username}::text, ${newPassword}::text) AS statement
        `;
        await sql.unsafe(statement);
      });
    },

    readFile: (path) => (existsSync(path) ? readFileSync(path, "utf-8") : null),
    writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
    deleteFile: (path) => {
      try {
        unlinkSync(path);
      } catch {
        // best effort — a stale file only costs one extra probe on later boots
      }
    },
    log: emit,
  };
}
