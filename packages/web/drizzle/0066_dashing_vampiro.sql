ALTER TABLE "email_workflows" DROP CONSTRAINT "email_workflows_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "email_workflows" ADD CONSTRAINT "email_workflows_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_delivered_files_user" ON "agent_delivered_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_recipients_notification_idx" ON "notification_recipients" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "idx_uploaded_files_lookup" ON "uploaded_files" USING btree ("agent_id","filename","user_id");