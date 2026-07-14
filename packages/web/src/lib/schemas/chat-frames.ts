/**
 * Shared types for WebSocket frames exchanged between the Pinchy server
 * (`server/client-router.ts`) and the browser runtime (`hooks/use-ws-runtime.ts`).
 *
 * AGENTS.md §"Shared Schemas And Typed Client" advises lifting cross-boundary
 * shapes here so server-side emit and client-side render agree at compile time.
 *
 * This file currently exports only the model-unavailable error payload because
 * it's the first frame field with semantic structure (rather than free-form
 * strings). Other frame shapes (history, ack, chunk, …) can migrate here as
 * they grow structure of their own.
 */

import { z } from "zod";

/**
 * Structured payload attached to an `error` frame when the upstream provider
 * returns an HTTP 5xx for a known model. The browser renders a dedicated
 * "model unavailable" bubble with a deep link to model settings; the server
 * also writes an `agent.model_unavailable` audit entry (throttled).
 *
 * Produced by `server/model-error-classifier.ts:classifyModelError`.
 * Consumed by `components/assistant-ui/chat-error-message.tsx`.
 */
export const modelUnavailableErrorSchema = z.object({
  kind: z.literal("model_unavailable"),
  model: z.string(),
  httpStatus: z.number(),
  ref: z.string().optional(),
});

export type ModelUnavailableError = z.infer<typeof modelUnavailableErrorSchema>;

/**
 * Structured payload attached to an `error` frame when the upstream provider
 * returns a retryable, time-limited failure — `errorClass: "transient"` from
 * `agent-error-classifier.ts` (rate limit, too-many-requests, overloaded,
 * timeout, HTTP 529). The browser renders a dedicated "paused" bubble whose
 * copy is honest about the specific cause: it must NOT say "rate limit" when
 * the real cause is "overloaded" or "timed out" (the `transient` class spans
 * all of them). `reason` carries that distinction.
 *
 * `sideEffects` is true when the run already executed at least one tool call
 * before failing. The bubble then warns that retrying re-runs the whole turn
 * and may DUPLICATE already-performed actions (e.g. Odoo writes) — retry is a
 * full re-prompt, not a resume-from-failure. This is the guardrail that keeps
 * the manual Retry from silently duplicating side effects.
 *
 * Reason is derived by `classifyTransientReason`; consumed by
 * `components/assistant-ui/chat-error-message.tsx`.
 */
export const transientErrorSchema = z.object({
  kind: z.literal("transient"),
  reason: z.enum(["rate_limit", "overloaded", "timeout", "unavailable"]),
  sideEffects: z.boolean(),
  model: z.string().optional(),
});

export type TransientError = z.infer<typeof transientErrorSchema>;
export type TransientReason = TransientError["reason"];
