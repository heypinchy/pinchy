DROP INDEX "email_workflows_enabled_idx";--> statement-breakpoint
CREATE INDEX "email_workflows_enabled_idx" ON "email_workflows" USING btree ("enabled") WHERE "email_workflows"."enabled";