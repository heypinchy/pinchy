ALTER TABLE "agents" ALTER COLUMN "visibility" SET DEFAULT 'restricted';--> statement-breakpoint
UPDATE "agents" SET "visibility" = 'restricted' WHERE "visibility" IN ('admin_only', 'groups');