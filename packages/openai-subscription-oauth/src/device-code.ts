export interface AuthorizationRequest {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export async function createAuthorizationRequest(params: {
  clientId: string;
  scope: string;
  endpoint?: string;
}): Promise<AuthorizationRequest> {
  const endpoint = params.endpoint ?? "https://auth.openai.com/api/accounts/deviceauth/usercode";
  const body = new URLSearchParams({
    client_id: params.clientId,
    scope: params.scope,
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`device-code request failed: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  return {
    deviceCode: json.device_code as string,
    userCode: json.user_code as string,
    verificationUri: json.verification_uri as string,
    verificationUriComplete: json.verification_uri_complete as string,
    expiresIn: json.expires_in as number,
    interval: json.interval as number,
  };
}
