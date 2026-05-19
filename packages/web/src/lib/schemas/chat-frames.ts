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
 * rejects the request payload due to a known schema/format defect that retry
 * usually clears (issue #338). The browser renders a dedicated "transient
 * upstream issue" bubble whose copy tells the user to click Retry — the
 * underlying generic provider-error wording sounds like Pinchy's fault, but
 * the cause is upstream (e.g. openclaw/openclaw#72879 dropping
 * `thought_signature` on Gemini 3 replay turns).
 *
 * `errorPattern` is the matched pattern family, kept open for future patterns
 * sharing the same UX shape. The server also writes an
 * `agent.upstream_format_error` audit entry (throttled) to make frequency
 * tracking automatic rather than manual log-grepping (issue #338 tracking
 * item #1).
 *
 * Produced by `server/model-error-classifier.ts:classifyUpstreamFormatError`.
 * Consumed by `components/assistant-ui/chat-error-message.tsx`.
 */
export const upstreamFormatErrorSchema = z.object({
  kind: z.literal("upstream_format_error"),
  model: z.string(),
  errorPattern: z.literal("thought_signature"),
  ref: z.string().optional(),
});

export type UpstreamFormatError = z.infer<typeof upstreamFormatErrorSchema>;
