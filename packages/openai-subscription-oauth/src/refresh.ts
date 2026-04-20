export interface RefreshedTokens {
  access: string;
  refresh: string;
  expires: number;
}

export async function refreshAccessToken(params: {
  refresh: string;
  clientId: string;
  endpoint?: string;
}): Promise<RefreshedTokens> {
  const endpoint = params.endpoint ?? "https://auth.openai.com/oauth/token";
  const body = new URLSearchParams({
    client_id: params.clientId,
    refresh_token: params.refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`token refresh failed: ${json.error ?? res.status}`);
  }
  return {
    access: json.access_token as string,
    refresh: (json.refresh_token as string | undefined) ?? params.refresh,
    expires: Date.now() + (json.expires_in as number) * 1000,
  };
}
