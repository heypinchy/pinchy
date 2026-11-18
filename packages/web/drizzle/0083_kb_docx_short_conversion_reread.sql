-- #1406: a .docx whose converted PDF failed the word-count check is now
-- indexed from its own text. Before that it was indexed with no text, and
-- after five such reads its row settled as "1|converter" — refused, and never
-- read again on the same bytes (ingest.ts, `couldReadDifferently`). Without
-- this migration every document the bug already hit stays unsearchable after
-- the upgrade.
--
-- The record does not say WHY the converter refused, so every settled .docx
-- refusal is owed the read, not only a short conversion: at most one extra
-- LibreOffice conversion each. Not a bump of EXTRACTION_VERSION,
-- which would re-read every empty document of every format — blank scans
-- through the vision model included.
--
-- One read, not five: incomplete_reads one short of the cap makes ingest read
-- it again (`retryOwed`), and a refusal on that read settles it right away.
-- The unsearchable list calls it "read on the next run" meanwhile.
-- Pinned against rows the old code wrote in
-- migration-kb-docx-short-conversion.integration.test.ts.
UPDATE "kb_documents"
SET "empty_extraction_by" = NULL, "incomplete_reads" = 4
WHERE "empty_extraction_by" = '1|converter'
  AND lower("source_path") LIKE '%.docx';
