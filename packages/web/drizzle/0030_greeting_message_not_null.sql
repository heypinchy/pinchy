-- Make agents.greeting_message NOT NULL.
-- Backfill any pre-existing NULL values with a neutral default before the
-- constraint is applied — historic agents from "the-pilot" preset (and any
-- agent whose template was missing a default) could otherwise have NULL.
UPDATE "agents"
SET "greeting_message" = 'Hi {user}. How can I help?'
WHERE "greeting_message" IS NULL;

ALTER TABLE "agents" ALTER COLUMN "greeting_message" SET NOT NULL;
