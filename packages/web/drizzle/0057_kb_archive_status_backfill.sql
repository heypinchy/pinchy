-- #858: backfill kb_documents.status for rows ingested before the archive
-- rule existed. The status is a pure function of source_path (see
-- src/lib/knowledge/archive-paths.ts): a document is archived iff any
-- DIRECTORY segment (never the basename) holds an archive word as a whole
-- token — a run of letters bounded by non-letters or the segment's ends —
-- case-insensitively (#1290). Letters are spelled as code-point ranges, not
-- [[:alpha:]], because that class depends on the database locale, and the
-- non-ASCII word ältere spells both cases out, since ~* folds non-ASCII
-- letters only under some locales. This regex
-- mirrors the rule exactly — the trailing '/' is what restricts the match to
-- directory segments — and the archive-backfill migration integration test
-- pins the two implementations together against a shared fixture set, so
-- they cannot drift apart silently.
--
-- One direction only (active -> archived): before this migration nothing ever
-- wrote 'archived', so there is no wrongly-archived row to flip back. Ingest
-- self-heals both directions from here on (the skip path re-derives the
-- status), so re-running ingest after a future rule change needs no further
-- migration.
UPDATE "kb_documents"
SET "status" = 'archived'
WHERE "status" = 'active'
  AND "source_path" ~* '(^|/)([^/]*[^/a-zA-ZÀ-ÖØ-öø-ɏ])?(old|older|xold|archive|archived|archiv|archives|archiviert|alte|(Ä|ä)ltere|veraltet|expired|obsolete)([^/a-zA-ZÀ-ÖØ-öø-ɏ][^/]*)?/';
