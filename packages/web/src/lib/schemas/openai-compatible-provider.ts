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
 *
 * Trust boundary: these fields (contextWindow, cost, capabilities) are accepted
 * from the admin verbatim — the discover path pre-fills them from the models.dev
 * catalog, but an admin editing their OWN provider may override them, and that
 * is intentional (they know their endpoint better than a snapshot does). The
 * values only feed OpenClaw's own token budgeting for that admin's deployment,
 * so there is no cross-tenant or privilege impact to bound here; the sensitive
 * inputs (the key, the base URL) are guarded separately (SecretRef + the SSRF
 * guard). Bounds below are sanity checks, not a security control.
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
 * A provider base URL. Restricted to http(s): a bare `z.string().url()` also
 * accepts `file://`, `gopher://`, etc., which — since Pinchy fetches this URL
 * server-side — would be an SSRF/LFI foothold. Network-level SSRF (internal /
 * metadata IPs) is enforced separately at the route edge by
 * `assertAllowedProviderUrl` (provider-url-guard.ts); this is the scheme half.
 */
const providerBaseUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "The base URL must start with http:// or https://.",
  });

/**
 * Request body for creating or updating an OpenAI-compatible provider.
 *
 * `id` present ⇒ update (the slug is immutable, derived once at create). On an
 * update `apiKey` is optional: omitting it keeps the existing stored key so the
 * client never has to round-trip the secret it can't read back.
 *
 * #894 backend redesign: the server now DISCOVERS the model list itself
 * (`GET <baseUrl>/models`, same live-with-snapshot-fallback path used for
 * reads — see the POST route and `resolveCustomProviderModels`) instead of
 * trusting a client-curated list. `manualModelIds` is the only client input
 * left for models, and only matters when discovery finds none (an endpoint
 * with no `/models`).
 *
 * `models` is a DEPRECATED, ignored-by-the-server field: the pre-redesign
 * form component (openai-compatible-provider-form.tsx) still sends its
 * discover-and-select checklist here, and that form is updated in a
 * follow-up task (see issue #894's UI/E2E/docs follow-up), not this one.
 * Keeping it optional here — rather than removing it outright — is what lets
 * that not-yet-updated form keep type-compiling against this shared schema in
 * the meantime; the route never reads it. Remove this field once the form
 * stops sending it.
 */
export const upsertOpenAiCompatibleProviderSchema = z.object({
  id: z.string().uuid().optional(),
  displayName: z.string().min(1).max(120),
  baseUrl: providerBaseUrlSchema,
  apiKey: z.string().min(1).optional(),
  /** @deprecated Ignored by the server — see the doc-comment above. */
  models: z.array(modelDefinitionSchema).optional(),
  /** Fallback model ids for an endpoint whose live discovery finds none. */
  manualModelIds: z.array(z.string().min(1)).optional(),
});

/** Request body for discovering a provider's models from its `/models` endpoint. */
export const discoverSchema = z.object({
  baseUrl: providerBaseUrlSchema,
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
