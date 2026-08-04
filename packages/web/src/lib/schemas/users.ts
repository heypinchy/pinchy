import { z } from "zod";
import { INVITE_ROLES } from "@/db/enums";

/**
 * Request schemas for the user-management routes, shared with the admin UI
 * (`invite-dialog.tsx`, `settings-users.tsx`, `user-detail-sheet.tsx`) so a
 * payload rename is a compile error rather than a runtime 400 (AGENTS.md
 * § "Shared Schemas And Typed Client").
 *
 * `@/db/enums` carries no database import — it is the const list the CHECK
 * constraints are generated from — so it is safe in a client bundle.
 */

/** `POST /api/users/invite` */
export const inviteUserSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(INVITE_ROLES),
  groupIds: z.array(z.string()).optional(),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

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
