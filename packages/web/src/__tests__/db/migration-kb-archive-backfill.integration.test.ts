/**
 * Migration-against-populated-data test for 0057_kb_archive_status_backfill
 * (#858), in the spirit #821 asks for: every kb_documents row that exists
 * BEFORE the migration was written by code that never set `status`, so a
 * fresh-DB run proves nothing — the archive backfill only matters for the
 * state a real upgrade produces (old rows, new code).
 *
 * Phase 1 migrates a throwaway DB to the pre-backfill state (journal idx ≤
 * 56), phase 2 seeds documents the way the OLD ingest wrote them (status
 * defaulting to 'active', archive paths included), phase 3 migrates to HEAD
 * and asserts the backfill flipped exactly the archive rows.
 *
 * The same fixture set then pins the migration's SQL regex to the TypeScript
 * rule (`isArchivedPath`, archive-paths.ts): both implementations are run
 * over every fixture path — the regex evaluated by REAL Postgres `~*`, not a
 * JS re-implementation — so the two cannot drift apart without going red.
 *
 * Runs under `pnpm -C packages/web test:db` (vitest-integration CI job).
 * Uses its own throwaway database, like migration-gap-repair.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isArchivedPath } from "@/lib/knowledge/archive-paths";

// vitest runs with cwd = packages/web; the real migrations live in ./drizzle.
const REAL_MIGRATIONS = join(process.cwd(), "drizzle");
const BACKFILL_IDX = 57;
const BACKFILL_SQL = join(REAL_MIGRATIONS, "0057_kb_archive_status_backfill.sql");

// Per-process DB name so concurrent runs can't collide on the throwaway DB.
const DB_NAME = `pinchy_kb_archive_backfill_test_${process.pid}`;

/**
 * Paths as the pre-#858 ingest persisted them, with the status the archive
 * rule assigns. Covers each decision the rule makes: case-insensitive
 * segment match, segment-exact (no substring), directory-segments-only
 * (never the basename), and year folders staying live.
 */
const FIXTURE_PATHS: Array<{ sourcePath: string; expected: "active" | "archived" }> = [
  { sourcePath: "/data/OLD/certificate-2013.pdf", expected: "archived" },
  { sourcePath: "/data/quality/old/binder.pdf", expected: "archived" },
  { sourcePath: "/data/Archive/2013/report.pdf", expected: "archived" },
  { sourcePath: "/data/archived/report.pdf", expected: "archived" },
  { sourcePath: "/data/Archiv/qualitaet/zertifikat.pdf", expected: "archived" },
  { sourcePath: "/data/old-versions/report.pdf", expected: "active" },
  { sourcePath: "/data/Goldakte/report.pdf", expected: "active" },
  { sourcePath: "/data/archive.pdf", expected: "active" },
  { sourcePath: "/data/2013/certificate.pdf", expected: "active" },
  { sourcePath: "/data/quality/certificate-2024.pdf", expected: "active" },
];

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
  version: string;
  breakpoints: boolean;
};

async function rewriteJournal(
  dir: string,
  transform: (entries: JournalEntry[]) => JournalEntry[]
): Promise<void> {
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf-8")) as {
    entries: JournalEntry[];
  };
  journal.entries = transform(journal.entries);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
}

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe("0057 kb archive status backfill (populated pre-#858 data)", () => {
  const baseUrl =
    process.env.DATABASE_URL ??
    process.env.VITEST_INTEGRATION_DB_URL ??
    "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";
  const adminUrl = withDbName(baseUrl, "postgres");
  const testUrl = withDbName(baseUrl, DB_NAME);

  let preBackfillDir: string;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }

    // Real .sql files, journal truncated to just before the backfill.
    preBackfillDir = await mkdtemp(join(tmpdir(), "pinchy-kb-backfill-pre-"));
    await cp(REAL_MIGRATIONS, preBackfillDir, { recursive: true });
    await rewriteJournal(preBackfillDir, (entries) => entries.filter((e) => e.idx < BACKFILL_IDX));
  });

  afterAll(async () => {
    if (preBackfillDir) await rm(preBackfillDir, { recursive: true, force: true });
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("flips exactly the archive-path rows from active to archived on upgrade", async () => {
    const client = postgres(testUrl, { max: 1 });
    try {
      // Phase 1 — the pre-backfill schema state.
      await migrate(drizzle(client), { migrationsFolder: preBackfillDir });

      // Phase 2 — seed rows the way pre-#858 ingest wrote them: no explicit
      // status, so every row is 'active' regardless of path.
      for (const { sourcePath } of FIXTURE_PATHS) {
        await client`
          INSERT INTO kb_documents (id, org_id, content_hash, source_path)
          VALUES (${crypto.randomUUID()}, 'org-backfill-test', ${"hash-" + sourcePath}, ${sourcePath})
        `;
      }
      const before = await client`
        SELECT count(*)::int AS n FROM kb_documents WHERE status = 'archived'
      `;
      expect(before[0].n).toBe(0); // proves the seeded state is genuinely pre-backfill

      // Phase 3 — upgrade to HEAD (applies 0057).
      await migrate(drizzle(client), { migrationsFolder: REAL_MIGRATIONS });

      const rows = await client`
        SELECT source_path, status FROM kb_documents WHERE org_id = 'org-backfill-test'
      `;
      const statusByPath = new Map(rows.map((r) => [r.source_path as string, r.status as string]));
      for (const { sourcePath, expected } of FIXTURE_PATHS) {
        expect(statusByPath.get(sourcePath), sourcePath).toBe(expected);
      }
    } finally {
      await client.end();
    }
  });

  it("keeps the migration's SQL regex and isArchivedPath() in lockstep (drift guard)", async () => {
    // Extract the regex literal from the COMMITTED migration file, so this
    // guard tests what actually ships, and evaluate it with real Postgres
    // `~*` semantics — never a JS re-implementation of POSIX regexes.
    const sqlText = await readFile(BACKFILL_SQL, "utf-8");
    const match = sqlText.match(/~\*\s*'([^']+)'/);
    if (!match) {
      throw new Error(
        `No ~* '<regex>' literal found in ${BACKFILL_SQL} — the drift guard must be updated alongside the migration`
      );
    }
    const regex = match[1];

    const client = postgres(testUrl, { max: 1 });
    try {
      for (const { sourcePath } of FIXTURE_PATHS) {
        const [{ matches }] = await client`
          SELECT ${sourcePath} ~* ${regex} AS matches
        `;
        expect(matches, `SQL regex vs isArchivedPath disagree on ${sourcePath}`).toBe(
          isArchivedPath(sourcePath)
        );
      }
    } finally {
      await client.end();
    }
  });
});
