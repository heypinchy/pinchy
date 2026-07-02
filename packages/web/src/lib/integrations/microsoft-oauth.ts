// MICROSOFT_OAUTH_BASE_URL allows E2E tests to redirect OAuth token refresh calls
// to a local mock server instead of https://login.microsoftonline.com/
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export function isTokenExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() - EXPIRY_BUFFER_MS < Date.now();
}

export async function refreshAccessToken(opts: {
  tenantId: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  // Read at call time so that test env-var overrides take effect between tests
  const tokenHost = process.env.MICROSOFT_OAUTH_BASE_URL || "https://login.microsoftonline.com";
  const tenant = opts.tenantId?.trim() || "organizations";

  const res = await fetch(`${tokenHost}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      scope: "offline_access User.Read Mail.ReadWrite Mail.Send",
    }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(`Microsoft token refresh failed: ${err.error_description ?? res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}
