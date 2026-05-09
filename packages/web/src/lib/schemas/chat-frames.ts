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
