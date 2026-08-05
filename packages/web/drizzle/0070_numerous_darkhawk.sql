ALTER TABLE "tool_approval" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
CREATE INDEX "tool_approval_call_idx" ON "tool_approval" USING btree ("tool_call_id");