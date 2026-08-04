// GMAIL_OAUTH_BASE_URL allows E2E tests to redirect OAuth token refresh calls
// to a local mock server instead of https://oauth2.googleapis.com/. It only
// takes effect alongside PINCHY_INSECURE_MAIL_MOCK=1 — see
// insecure-mock-base-url.ts. This request carries the client secret AND the
// refresh token, so an unflagged redirect here hands over long-lived
// credentials, not a token that expires.
import { computeExpiresAt } from "./oauth-token";
import { resolveInsecureMockBaseUrl } from "./insecure-mock-base-url";

const GOOGLE_TOKEN_DEFAULT = "https://oauth2.googleapis.com/token";

/**
 * Resolved per call, not once at module load: the flag pairing has to be read
 * after the process env is fully set up, and a module-level const would also
 * make the seam untestable without a module reset.
 */
export function googleTokenEndpoint(): string {
  const base = resolveInsecureMockBaseUrl("GMAIL_OAUTH_BASE_URL");
  return base ? `${base}/token` : GOOGLE_TOKEN_DEFAULT;
}

export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const res = await fetch(googleTokenEndpoint(), {
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
  const expiresAt = computeExpiresAt(data.expires_in);

  return {
    accessToken: data.access_token,
    expiresAt,
  };
}
