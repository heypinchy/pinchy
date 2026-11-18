-- #933, second half: with every anchor carried into `locator` by 0061, the old
-- column goes. Dropping it is the point rather than tidiness — a column that
-- still exists is a column ingest can still be made to write, and two anchors
-- for one chunk is exactly the drift the closed locator union exists to stop.
ALTER TABLE "kb_chunks" DROP COLUMN "page";
