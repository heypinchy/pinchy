/**
 * Migration-against-populated-data test for 0060_kb_chunk_locator (#933), in
 * the spirit AGENTS.md § "Test Migrations Against Pre-Existing Data" asks for:
 * every kb_chunks row that exists BEFORE this migration was written by code
 * that stored a bare `page` integer, so a fresh-DB run proves nothing. The
 * column swap only matters for the state a real upgrade produces — old rows,
 * new code — and getting it wrong silently blanks the anchor on every citation
 * in an existing corpus while the whole suite stays green.
 *
 * Phase 1 migrates a throwaway DB to the pre-locator state (journal idx < 60,
 * i.e. before 0060's ADD + backfill and 0061's DROP),
 * phase 2 seeds chunks the way the OLD ingest wrote them (`page` integer, NULL
 * included), phase 3 migrates to HEAD and asserts every page became the
 * equivalent page locator — and that a NULL page did NOT become a fabricated
 * one.
 *
 * Phase 4 then reads those migrated rows through the NEW retrieval projection,
 * because "the column converted" and "retrieval still answers with an anchor"
 * are different claims and only the second one is what a reader gets.
 *
 * Runs under `pnpm -C packages/web test:db` (vitest-integration CI job).
 * Uses its own throwaway database, like migration-kb-archive-backfill.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatLocator, type ChunkLocator } from "@/lib/knowledge/locator";

// vitest runs with cwd = packages/web; the real migrations live in ./drizzle.
const REAL_MIGRATIONS = join(process.cwd(), "drizzle");
// The ADD + backfill (0060) and the DROP (0061) are separate migrations, so
// "before the change" means before the first of them.
const LOCATOR_IDX = 60;

// Per-process DB name so concurrent runs can't collide on the throwaway DB.
const DB_NAME = `pinchy_kb_chunk_locator_test_${process.pid}`;

/** Chunks as the pre-#933 ingest persisted them: a bare `page`, nullable. */
const FIXTURE_CHUNKS: Array<{ chunkText: string; page: number | null }> = [
  { chunkText: "First page of the handbook.", page: 1 },
  { chunkText: "Deep in a long binder.", page: 275 },
  { chunkText: "A chunk whose page was never recorded.", page: null },
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

describe("0060 kb chunk locator (populated pre-#933 data)", () => {
  const baseUrl =
    process.env.DATABASE_URL ??
    process.env.VITEST_INTEGRATION_DB_URL ??
    "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";
  const adminUrl = withDbName(baseUrl, "postgres");
  const testUrl = withDbName(baseUrl, DB_NAME);

  let preLocatorDir: string;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }

    // Real .sql files, journal truncated to just before the locator swap.
    preLocatorDir = await mkdtemp(join(tmpdir(), "pinchy-kb-locator-pre-"));
    await cp(REAL_MIGRATIONS, preLocatorDir, { recursive: true });
    await rewriteJournal(preLocatorDir, (entries) => entries.filter((e) => e.idx < LOCATOR_IDX));
  });

  afterAll(async () => {
    if (preLocatorDir) await rm(preLocatorDir, { recursive: true, force: true });
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("converts a pre-existing page into a page locator, and a null page into no locator", async () => {
    const client = postgres(testUrl, { max: 1 });
    try {
      // Phase 1 — the pre-locator schema state.
      await migrate(drizzle(client), { migrationsFolder: preLocatorDir });

      // Proves the seeded state is genuinely pre-migration: the old column is
      // there and the new one is not. Without this the test could silently
      // become a fresh-DB test again if the journal filter ever stops biting.
      const preColumns = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'kb_chunks' AND column_name IN ('page', 'locator')
      `;
      expect(preColumns.map((c) => c.column_name).sort()).toEqual(["page"]);

      // Phase 2 — seed rows the way pre-#933 ingest wrote them.
      const documentId = crypto.randomUUID();
      await client`
        INSERT INTO kb_documents (id, org_id, content_hash, source_path)
        VALUES (${documentId}, 'org-locator-test', 'hash-locator', '/data/noack/QM/handbook.pdf')
      `;
      for (const { chunkText, page } of FIXTURE_CHUNKS) {
        await client`
          INSERT INTO kb_chunks (id, document_id, org_id, source_path, chunk_text, page)
          VALUES (
            ${crypto.randomUUID()}, ${documentId}, 'org-locator-test',
            '/data/noack/QM/handbook.pdf', ${chunkText}, ${page}
          )
        `;
      }

      // Phase 3 — upgrade to HEAD (applies 0060).
      await migrate(drizzle(client), { migrationsFolder: REAL_MIGRATIONS });

      const rows = await client<{ chunk_text: string; locator: ChunkLocator | null }[]>`
        SELECT chunk_text, locator FROM kb_chunks WHERE org_id = 'org-locator-test'
      `;
      const byText = new Map(rows.map((r) => [r.chunk_text, r.locator]));

      for (const { chunkText, page } of FIXTURE_CHUNKS) {
        expect(byText.get(chunkText), chunkText).toEqual(
          page === null ? null : { kind: "page", page }
        );
      }

      // Phase 4 — the rows a pre-#933 corpus consists of still render an
      // anchor. The conversion is only worth anything if this holds.
      const migrated = byText.get("Deep in a long binder.");
      expect(migrated).not.toBeNull();
      expect(formatLocator(migrated as ChunkLocator)).toBe("p. 275");
    } finally {
      await client.end();
    }
  });

  it("drops the page column, so nothing can keep writing the old anchor", async () => {
    const client = postgres(testUrl, { max: 1 });
    try {
      const columns = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'kb_chunks' AND column_name IN ('page', 'locator')
      `;
      expect(columns.map((c) => c.column_name).sort()).toEqual(["locator"]);
    } finally {
      await client.end();
    }
  });
});
