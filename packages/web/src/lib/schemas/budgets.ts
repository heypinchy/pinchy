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
 *
 * Those fields are dropped, not rejected, when they arrive malformed (`null`,
 * a number, too long): the plugin lets a run through on any error answer, so
 * a 400 over an audit detail would switch the budget off for every run.
 */
const optionalDetail = (max: number) => z.string().max(max).optional().catch(undefined);

export const budgetCheckSchema = z.object({
  agentId: z.string().min(1).max(200),
  sessionKey: optionalDetail(500),
  channel: optionalDetail(100),
  senderId: optionalDetail(200),
  trigger: optionalDetail(100),
});
export type BudgetCheckInput = z.infer<typeof budgetCheckSchema>;
