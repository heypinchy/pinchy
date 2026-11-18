import { z } from "zod";

/**
 * `POST /api/invite/claim` — redeem an invite or a password-reset link. Shared
 * with the claim page (agent-rules/web-routes.md § "Shared Schemas And Typed Client").
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

/**
 * `GET /api/invite/[token]` — what the claim page needs before it renders.
 *
 * The caller is unauthenticated, so this is everything a holder of a valid
 * token may learn: the flow, the address the account signs in with (their
 * own), and the inviter's display name — never the inviter's email. An
 * unknown, claimed or expired token gets an error and nothing else.
 */
export type InviteTokenInfo = {
  type: "invite" | "reset";
  /** The sign-in address. Always set: a token without one gets a 410. */
  email: string;
  /**
   * Display name of the admin who created the invite. `null` on a reset, and
   * when that admin has no name or has been deactivated.
   */
  invitedBy: string | null;
};
