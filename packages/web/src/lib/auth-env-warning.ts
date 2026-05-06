export function getBetterAuthUrlStartupWarning(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!env.BETTER_AUTH_URL) return null;

  return (
    "⚠ BETTER_AUTH_URL is set. Domain Lock is configured via Settings → Security; " +
    "BETTER_AUTH_URL still controls Better Auth callback URLs."
  );
}
