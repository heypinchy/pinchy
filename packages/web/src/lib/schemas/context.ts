import { z } from "zod";

/**
 * Upper bound on stored context content (user and org). This text is
 * re-injected into the prompt on every chat turn, so an unbounded value is
 * not just a storage concern: it's a permanent, per-turn token-cost and
 * context-window tax for every conversation that uses it. 16,000 characters
 * is generous for prose while keeping that injection bounded.
 */
export const CONTEXT_CONTENT_MAX_LENGTH = 16_000;

/** Shared by the user-context (`/api/users/me/context`) and org-context
 * (`/api/settings/context`) PUT routes. */
export const contextContentSchema = z.object({
  content: z.string().max(CONTEXT_CONTENT_MAX_LENGTH),
});
