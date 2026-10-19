import { z } from "zod";
import { BUDGET_ACTIONS } from "@/db/enums";

/**
 * `PUT /api/budgets` — create or replace the instance budget (`agentId: null`)
 * or one agent's. Shared with the Budgets card (AGENTS.md § "Shared Schemas
 * And Typed Client"). The limit is USD per calendar month; the route stores it
 * rounded to cents.
 */
export const upsertBudgetSchema = z
  .object({
    agentId: z.string().min(1).nullable(),
    monthlyLimitUsd: z.number().min(0.01).max(1_000_000_000),
    onExceeded: z.enum(BUDGET_ACTIONS),
  })
  .strict();
export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;

/**
 * `POST /api/internal/budgets/check` — asked by pinchy-audit's
 * `before_agent_run` gate before every OpenClaw run, on every channel. The
 * fields beside `agentId` come from OpenClaw's hook context and only shape the
 * audit row of a refusal.
 */
export const budgetCheckSchema = z.object({
  agentId: z.string().min(1).max(200),
  sessionKey: z.string().max(500).optional(),
  channel: z.string().max(100).optional(),
  senderId: z.string().max(200).optional(),
  trigger: z.string().max(100).optional(),
});
export type BudgetCheckInput = z.infer<typeof budgetCheckSchema>;
