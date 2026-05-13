export function getBetterAuthUrlStartupWarning(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!env.BETTER_AUTH_URL) return null;

  return (
    "⚠ BETTER_AUTH_URL is set. Request-host trust is now configured via Domain Lock " +
    "(Settings → Security). BETTER_AUTH_URL only controls outbound URLs Better Auth " +
    "writes into email verification and password reset links — make sure it matches " +
    "the hostname your users actually open Pinchy at."
  );
}
