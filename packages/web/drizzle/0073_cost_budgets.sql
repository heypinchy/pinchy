CREATE TABLE "cost_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text,
	"monthly_limit_usd" numeric(12, 2) NOT NULL,
	"on_exceeded" text NOT NULL,
	"warned_period" text,
	"exceeded_period" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cost_budgets_agent_id_unique" UNIQUE NULLS NOT DISTINCT("agent_id"),
	CONSTRAINT "cost_budgets_on_exceeded_check" CHECK ("cost_budgets"."on_exceeded" IN ('notify', 'block')),
	CONSTRAINT "cost_budgets_limit_positive_check" CHECK ("cost_budgets"."monthly_limit_usd" > 0)
);
--> statement-breakpoint
ALTER TABLE "cost_budgets" ADD CONSTRAINT "cost_budgets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;