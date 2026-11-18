import { z } from "zod";
import { API_KEY_SCOPES } from "@/lib/api-key-scopes";

/**
 * Request schema for issuing an Agent Provisioning API key (#572).
 * Shared by the admin-authenticated POST /api/settings/api-keys route and the
 * admin key-management UI, so both validate identical input.
 */
export const createApiKeySchema = z.object({
  name: z
    .string()
    .min(1)
    // Matches @better-auth/api-key's own `maximumNameLength` default (32,
    // unconfigured by Pinchy's `apiKey()` plugin setup in lib/auth.ts) — a
    // longer name would pass this schema but then fail inside
    // auth.api.createApiKey with an uncaught INVALID_NAME_LENGTH APIError
    // (500) instead of a clean 400. Keeping the caps aligned means every
    // rejection surfaces as a validation error.
    .max(32),
  // At least one scope: default-deny, mirroring the agent-permissions
  // allow-list model — a key issued with no scopes would be a key that
  // (accidentally) grants nothing, which is confusing, but requiring >=1
  // forces the issuer to make an explicit choice up front.
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  // Matches @better-auth/api-key's own `keyExpiration.maxExpiresIn` default
  // (365 days, unconfigured by Pinchy's `apiKey()` plugin setup in
  // lib/auth.ts) — same reasoning as `name`'s cap above: without this, a
  // value that passes this schema but exceeds the plugin's own cap would
  // fail inside auth.api.createApiKey with an uncaught EXPIRES_IN_IS_TOO_LARGE
  // APIError (500) instead of a clean 400.
  expiresInDays: z.number().int().positive().max(365).optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
