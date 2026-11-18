import { z } from "zod";

// Request schema for setting `default_provider` to a built-in provider name OR
// a custom OpenAI-compatible provider's slug (#894 settings redesign). A bare
// `z.string()` here — not `z.enum(VALID_PROVIDERS)` like the built-in
// setup/delete routes — because a valid target can ALSO be a custom slug,
// which isn't known statically. The route itself validates that the target is
// actually configured (a built-in with a settings key present, or an existing
// custom slug); this schema only guards against an empty/missing body field.
export const setDefaultProviderSchema = z.object({
  provider: z.string().min(1),
});

export type SetDefaultProviderInput = z.infer<typeof setDefaultProviderSchema>;
