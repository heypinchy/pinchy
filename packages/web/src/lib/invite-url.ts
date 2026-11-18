/**
 * Builds the absolute invite / password-reset link from an origin and token.
 *
 * Which origin is the job of `resolveLinkOrigin` (lib/link-origin.ts): the
 * locked domain when one is set, otherwise the host the request arrived on.
 * There is deliberately no base-URL env var in between — `BETTER_AUTH_URL`
 * was removed for that reason, see issue #352.
 */
export function buildInviteUrl(origin: string, token: string): string {
  return `${origin}/invite/${token}`;
}
