/**
 * Integration test for the 0083_kb_docx_short_conversion_reread migration.
 *
 * Before #1406 a .docx whose converted PDF failed the word-count check was
 * indexed with no text at all, and after five reads its row settled as
 * "1|converter": refused by the converter, not to be read again. The fix reads
 * such a .docx from its own text — but ingest never reaches a settled row on
 * the same bytes, so without this migration every document the bug already hit
 * would stay unsearchable after the upgrade.
 *
 * The migration owes those rows exactly one more read. It runs against rows the
 * OLD code wrote (agent-rules/testing.md § "Test Migrations Against
 * Pre-Existing Data"): a fresh database has none.
 */

import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { kbDocuments } from "@/db/schema";
import { migrationStatements, runMigrationFile } from "@/test-helpers/run-migration-file";

const MIGRATION = "0083_kb_docx_short_conversion_reread.sql";
const ORG_ID = "org-migration-0083";

async function seed(sourcePath: string, emptyExtractionBy: string | null, incompleteReads: number) {
  await db.insert(kbDocuments).values({
    orgId: ORG_ID,
    sourcePath,
    contentHash: `hash-${sourcePath}`,
    emptyExtractionBy,
    incompleteReads,
  });
}

async function recordOf(sourcePath: string) {
  const [row] = await db
    .select({
      emptyExtractionBy: kbDocuments.emptyExtractionBy,
      incompleteReads: kbDocuments.incompleteReads,
    })
    .from(kbDocuments)
    .where(eq(kbDocuments.sourcePath, sourcePath));
  return row;
}

describe("0083 kb .docx short-conversion reread migration", () => {
  afterEach(async () => {
    await db.delete(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
  });

  it("is one UPDATE of kb_documents", () => {
    // The tests below that expect a row untouched would pass on an empty file.
    const statements = migrationStatements(MIGRATION);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^UPDATE "kb_documents"/);
  });

  it("owes a .docx the converter settled on one more read", async () => {
    await seed("/data/katalog.docx", "1|converter", 5);
    await seed("/data/ANGEBOT.DOCX", "1|converter", 5);

    await runMigrationFile(MIGRATION);

    // One read short of settled: the next run reads it again, and a read that
    // is refused once more settles it right away.
    for (const path of ["/data/katalog.docx", "/data/ANGEBOT.DOCX"]) {
      expect(await recordOf(path)).toEqual({ emptyExtractionBy: null, incompleteReads: 4 });
    }
  });

  it("leaves every other settled or pending record as it is", async () => {
    // A .doc or .ppt has no source text to fall back on; a scan's record
    // belongs to the vision model; a .docx still under its retries is read
    // again anyway; a record from a later extractor is not one the bug wrote.
    await seed("/data/alt.doc", "1|converter", 5);
    await seed("/data/messe.ppt", "1|converter", 5);
    await seed("/data/scan.docx", "1|ocr:qwen2.5vl", 5);
    await seed("/data/pending.docx", null, 2);
    await seed("/data/later.docx", "2|converter", 5);
    await seed("/data/katalog.docx.bak", "1|converter", 5);

    await runMigrationFile(MIGRATION);

    expect(await recordOf("/data/alt.doc")).toEqual({
      emptyExtractionBy: "1|converter",
      incompleteReads: 5,
    });
    expect(await recordOf("/data/messe.ppt")).toEqual({
      emptyExtractionBy: "1|converter",
      incompleteReads: 5,
    });
    expect(await recordOf("/data/scan.docx")).toEqual({
      emptyExtractionBy: "1|ocr:qwen2.5vl",
      incompleteReads: 5,
    });
    expect(await recordOf("/data/pending.docx")).toEqual({
      emptyExtractionBy: null,
      incompleteReads: 2,
    });
    expect(await recordOf("/data/later.docx")).toEqual({
      emptyExtractionBy: "2|converter",
      incompleteReads: 5,
    });
    expect(await recordOf("/data/katalog.docx.bak")).toEqual({
      emptyExtractionBy: "1|converter",
      incompleteReads: 5,
    });
  });
});
