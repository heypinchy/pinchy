CREATE TABLE "agent_connection_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"credentials" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "agent_connection_permissions" ADD CONSTRAINT "agent_connection_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connection_permissions" ADD CONSTRAINT "agent_connection_permissions_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_conn_model_op" ON "agent_connection_permissions" USING btree ("agent_id","connection_id","model","operation");--> statement-breakpoint
CREATE INDEX "idx_agent_conn_perms_agent" ON "agent_connection_permissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_conn_perms_conn" ON "agent_connection_permissions" USING btree ("connection_id");