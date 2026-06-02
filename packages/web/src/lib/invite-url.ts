/**
 * Builds the absolute invite / password-reset link that admins copy and share.
 *
 * The link is derived purely from `origin` — in practice
 * `window.location.origin`, i.e. the host the admin is currently browsing.
 * Pinchy deliberately does NOT build this from a configured base URL (such as
 * the former `BETTER_AUTH_URL` env var): there is no Better Auth email flow,
 * so the only correct origin is the one the admin is already on. This is why
 * `BETTER_AUTH_URL` was safe to remove — see issue #352.
 */
export function buildInviteUrl(origin: string, token: string): string {
  return `${origin}/invite/${token}`;
}
