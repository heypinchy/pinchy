// GMAIL_OAUTH_BASE_URL allows E2E tests to redirect OAuth token refresh calls
// to a local mock server instead of https://oauth2.googleapis.com/
const TOKEN_ENDPOINT = process.env.GMAIL_OAUTH_BASE_URL
  ? `${process.env.GMAIL_OAUTH_BASE_URL}/token`
  : "https://oauth2.googleapis.com/token";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export function isTokenExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() - EXPIRY_BUFFER_MS < Date.now();
}

export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`Token refresh failed: ${(error as { error?: string }).error ?? res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  return {
    accessToken: data.access_token,
    expiresAt,
  };
}
