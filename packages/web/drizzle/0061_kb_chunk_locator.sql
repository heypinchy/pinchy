-- #933: kb_chunks anchors a chunk with a LOCATOR, not a page.
--
-- Only PDFs have pages. A PowerPoint chunk is anchored by slide, a spreadsheet
-- chunk by sheet + row range, and a Word chunk by its heading path — because
-- Word pagination is a rendering result (fonts, printer metrics, Word vs
-- LibreOffice), so a page number is not a property of the document the reader
-- opens. Citing one would state something false about the file the user opens.
--
-- The backfill is total and lossless in the direction that matters: every
-- existing row was written by the PDF ingest, so `page` IS its honest anchor
-- and becomes the equivalent page locator. A row whose page was never recorded
-- keeps no anchor rather than gaining a fabricated one.
--
-- Split across two migrations on purpose. The ADD + backfill is committed
-- before 0062 drops `page`, so a run that dies between them leaves every anchor
-- already carried over instead of destroyed. The shape of that conversion is
-- pinned against rows written by the OLD code in
-- migration-kb-chunk-locator.integration.test.ts (AGENTS.md § "Test Migrations
-- Against Pre-Existing Data") — a fresh-DB run proves nothing here, since every
-- row that needs converting predates the column.
ALTER TABLE "kb_chunks" ADD COLUMN "locator" jsonb;--> statement-breakpoint
UPDATE "kb_chunks"
SET "locator" = jsonb_build_object('kind', 'page', 'page', "page")
WHERE "page" IS NOT NULL;
