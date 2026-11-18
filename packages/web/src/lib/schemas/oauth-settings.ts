import { z } from "zod";

// Shared with POST /api/settings/oauth (parseRequestBody) and the client
// dialogs (add-integration-dialog.tsx, edit-oauth-dialog.tsx) that build the
// typed request body, per agent-rules/web-routes.md's "Shared Schemas And Typed Client" rule.
export const saveGoogleOAuthSchema = z.object({
  provider: z.literal("google"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});

export const saveMicrosoftOAuthSchema = z.object({
  provider: z.literal("microsoft"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
});

export const saveOAuthSchema = z.discriminatedUnion("provider", [
  saveGoogleOAuthSchema,
  saveMicrosoftOAuthSchema,
]);

export type SaveGoogleOAuthRequest = z.infer<typeof saveGoogleOAuthSchema>;
export type SaveMicrosoftOAuthRequest = z.infer<typeof saveMicrosoftOAuthSchema>;
export type SaveOAuthRequest = z.infer<typeof saveOAuthSchema>;
