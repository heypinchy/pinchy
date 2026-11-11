import { z } from "zod";
import { INVITE_ROLES } from "@/db/enums";

/**
 * Request schemas for the user-management routes, shared with the admin UI
 * (`invite-dialog.tsx`, `settings-users.tsx`, `user-detail-sheet.tsx`) so a
 * payload rename is a compile error rather than a runtime 400 (agent-rules/web-routes.md
 * § "Shared Schemas And Typed Client").
 *
 * `@/db/enums` carries no database import — it is the const list the CHECK
 * constraints are generated from — so it is safe in a client bundle.
 */

/** `POST /api/users/invite` */
export const inviteUserSchema = z.object({
  // Required: claiming the invite creates the account with this address, so
  // an invite without one is a link that can never work (#1263).
  email: z.string().trim().pipe(z.email()),
  role: z.enum(INVITE_ROLES),
  groupIds: z.array(z.string()).optional(),
  // Email the invitation through the system mailer (#1309). Ignored-safe: the
  // invite is created either way, and the link comes back in the response.
  sendEmail: z.boolean().optional(),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

/**
 * `POST /api/users/[userId]/reset`. The body is optional (the route predates
 * it), so this is parsed with `parseOptionalRequestBody`.
 */
export const resetPasswordSchema = z.object({ sendEmail: z.boolean().optional() }).strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** `PATCH /api/users/[userId]` — role change only. */
export const updateUserSchema = z.object({
  role: z.enum(["admin", "member"]),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/** `PUT /api/users/[userId]/groups` — full replace of the user's memberships. */
export const updateUserGroupsSchema = z.object({
  groupIds: z.array(z.string()),
});
export type UpdateUserGroupsInput = z.infer<typeof updateUserGroupsSchema>;

/**
 * `POST /api/users/[userId]/acknowledge-origin` — "Mark as known" on an account
 * the provenance check flagged. Takes no fields; `strict()` so a client that
 * starts sending one (a reason, say) gets a 400 instead of a silent drop.
 */
export const acknowledgeUserOriginSchema = z.object({}).strict();
export type AcknowledgeUserOriginInput = z.infer<typeof acknowledgeUserOriginSchema>;
