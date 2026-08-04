import { z } from "zod";
import { PROVIDERS, type ProviderName } from "@/lib/providers";

/**
 * Request schemas for the built-in provider routes, shared with
 * `provider-key-form.tsx` (AGENTS.md § "Shared Schemas And Typed Client").
 *
 * `@/lib/providers` is a const table plus one pure URL helper — no database,
 * no settings — so it is safe in a client bundle, and the form already imports
 * `ProviderName` from it.
 */
const VALID_PROVIDERS = Object.keys(PROVIDERS) as [ProviderName, ...ProviderName[]];

/** `POST /api/setup/provider` — save an API key or a local-runtime URL. */
export const setupProviderSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  url: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});
export type SetupProviderInput = z.infer<typeof setupProviderSchema>;

/** `DELETE /api/settings/providers` — remove a configured provider. */
export const deleteProviderSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
});
export type DeleteProviderInput = z.infer<typeof deleteProviderSchema>;
