CREATE INDEX "idx_chat_session_errors_user" ON "chat_session_errors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_session_errors_agent" ON "chat_session_errors" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "email_workflow_connections_connection_idx" ON "email_workflow_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "email_workflows_created_by_idx" ON "email_workflows" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "invite_groups_group_idx" ON "invite_groups" USING btree ("group_id");