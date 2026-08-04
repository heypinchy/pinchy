import { z } from "zod";

/**
 * `POST /api/invite/claim` — redeem an invite or a password-reset link. Shared
 * with the claim page (AGENTS.md § "Shared Schemas And Typed Client").
 *
 * `name` is optional because the reset branch has no name to set; `password`
 * is shape-only, with the length/breach-list policy enforced post-parse via
 * `validatePassword()`.
 */
export const claimInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().optional(),
  password: z.string(),
});
export type ClaimInviteInput = z.infer<typeof claimInviteSchema>;
