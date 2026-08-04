import { z } from "zod";

/**
 * Request schemas for the settings- and self-service routes, shared with their
 * client counterparts so a rename on either side is a compile error rather
 * than a runtime 400 (AGENTS.md § "Shared Schemas And Typed Client").
 *
 * These are the ROUTE's shapes. The forms keep their own schemas where the
 * form is not the payload — `settings-profile.tsx` validates a
 * `confirmPassword` field that is deliberately never sent.
 */

/** `POST /api/settings` — one org-level key/value setting. */
export const orgSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type OrgSettingInput = z.infer<typeof orgSettingSchema>;

// The org- and user-level context PUTs (`/api/settings/context`,
// `/api/users/me/context`) are NOT here: they share `contextContentSchema`
// in `@/lib/schemas/context`, which also carries the length cap and its
// message. One shape, one file — a second definition here would be exactly
// the drift this directory exists to prevent.

/** `PATCH /api/users/me` — the signed-in user's own display name. */
export const updateMeSchema = z.object({
  name: z
    .string()
    .min(1)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, "Name is required"),
});
/**
 * The INPUT type, not the output: `transform` makes `z.infer` the post-parse
 * shape, which is what the route reads. A client body is pre-parse, so it must
 * be typed with `z.input` or the trim would look required of the caller.
 */
export type UpdateMeInput = z.input<typeof updateMeSchema>;

/**
 * `POST /api/users/me/password` — shape only. The length/breach-list policy is
 * enforced post-parse via `validatePassword()` so setup, invite-claim and
 * password-change cannot drift apart.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string(),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
