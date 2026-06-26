CREATE TABLE "agent_mcp_tool_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_mcp_tool_permissions" ADD CONSTRAINT "agent_mcp_tool_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_tool_permissions" ADD CONSTRAINT "agent_mcp_tool_permissions_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_mcp_tool" ON "agent_mcp_tool_permissions" USING btree ("agent_id","connection_id","tool_name");--> statement-breakpoint
CREATE INDEX "idx_agent_mcp_perms_agent" ON "agent_mcp_tool_permissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_mcp_perms_conn" ON "agent_mcp_tool_permissions" USING btree ("connection_id");