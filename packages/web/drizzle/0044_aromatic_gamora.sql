ALTER TABLE "invites" DROP CONSTRAINT "invites_claimed_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_claimed_by_user_id_user_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_groups_group_id_idx" ON "agent_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_audit_resource_timestamp" ON "audit_log" USING btree ("resource","timestamp");--> statement-breakpoint
CREATE INDEX "invites_created_by_idx" ON "invites" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "invites_claimed_by_user_id_idx" ON "invites" USING btree ("claimed_by_user_id");--> statement-breakpoint
CREATE INDEX "invites_email_expires_at_idx" ON "invites" USING btree ("email","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_user_timestamp" ON "usage_records" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_usage_agent_timestamp" ON "usage_records" USING btree ("agent_id","timestamp");--> statement-breakpoint
CREATE INDEX "user_groups_group_id_idx" ON "user_groups" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_visibility_check" CHECK ("agents"."visibility" IN ('restricted', 'all'));--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_type_check" CHECK ("integration_connections"."type" IN ('odoo', 'web-search', 'google', 'microsoft', 'imap'));--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_status_check" CHECK ("integration_connections"."status" IN ('active', 'pending', 'auth_failed'));--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_role_check" CHECK ("invites"."role" IN ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_type_check" CHECK ("invites"."type" IN ('invite', 'reset'));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "users_role_check" CHECK ("user"."role" IN ('admin', 'member'));