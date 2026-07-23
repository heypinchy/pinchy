import { z } from "zod";

// Request schemas for the generic "OpenAI-compatible" provider write paths
// (#894). Single source of truth, imported by BOTH the route handlers
// (parseRequestBody) and the client components (typed bodies via z.infer) so
// the two sides can't drift — AGENTS.md "Shared Schemas And Typed Client".

/**
 * A single persisted model definition. Field-for-field mirror of
 * {@link OpenClawModelDefinition} (packages/web/src/lib/openclaw-builtin-models.ts):
 * same field names, and `cost` carries exactly the four keys OpenClaw's
 * per-agent model-catalog schema requires (input/output/cacheRead/cacheWrite).
 * This schema validates the model defs a user persists for their provider.
 */
export const modelDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  input: z.array(z.string()).min(1),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
});

/**
 * Request body for creating or updating an OpenAI-compatible provider.
 *
 * `id` present ⇒ update (the slug is immutable, derived once at create). On an
 * update `apiKey` is optional: omitting it keeps the existing stored key so the
 * client never has to round-trip the secret it can't read back. At least one
 * model is required — a provider with no models is inert.
 */
export const upsertOpenAiCompatibleProviderSchema = z.object({
  id: z.string().uuid().optional(),
  displayName: z.string().min(1).max(120),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
  models: z.array(modelDefinitionSchema).min(1),
});

/** Request body for discovering a provider's models from its `/models` endpoint. */
export const discoverSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
});

/** Request body for deleting an OpenAI-compatible provider. */
export const deleteOpenAiCompatibleSchema = z.object({
  id: z.string().uuid(),
});

export type ModelDefinitionInput = z.infer<typeof modelDefinitionSchema>;
export type UpsertOpenAiCompatibleProviderInput = z.infer<
  typeof upsertOpenAiCompatibleProviderSchema
>;
export type DiscoverInput = z.infer<typeof discoverSchema>;
export type DeleteOpenAiCompatibleInput = z.infer<typeof deleteOpenAiCompatibleSchema>;
