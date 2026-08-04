import { z } from "zod";

/**
 * Upper bound on stored context content (user and org). This text is
 * re-injected into the prompt on every chat turn, so an unbounded value is
 * not just a storage concern: it's a permanent, per-turn token-cost and
 * context-window tax for every conversation that uses it. 16,000 characters
 * is generous for prose while keeping that injection bounded.
 */
export const CONTEXT_CONTENT_MAX_LENGTH = 16_000;

/**
 * Every consumer of a rejected save reads one string and shows it: the
 * settings UI renders it inline, and `pinchy-context` hands it back to the
 * model as the tool's error. Zod's default ("Too big: expected string to have
 * <=16000 characters") names neither the field in human terms nor what to do,
 * so the message is written here and asserted by the route tests.
 */
export const CONTEXT_TOO_LONG_MESSAGE = `Context is too long — the limit is ${CONTEXT_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters.`;

/** Shared by the user-context (`/api/users/me/context`) and org-context
 * (`/api/settings/context`) PUT routes, and by their gateway-authed
 * `/api/internal/…` equivalents. */
export const contextContentSchema = z.object({
  content: z.string().max(CONTEXT_CONTENT_MAX_LENGTH, { message: CONTEXT_TOO_LONG_MESSAGE }),
});
