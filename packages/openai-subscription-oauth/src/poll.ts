import { extractAccountInfo } from "./jwt";

export interface TokenSet {
  access: string;
  refresh: string;
  expires: number; // epoch ms
  accountId: string;
  accountEmail: string;
}

export async function pollForToken(params: {
  deviceCode: string;
  clientId: string;
  intervalSeconds: number;
  endpoint?: string;
  maxAttempts?: number;
}): Promise<TokenSet> {
  // Verified from openai/codex codex-rs/login source — proprietary path, differs from RFC 8628 default
  const endpoint = params.endpoint ?? "https://auth.openai.com/api/accounts/deviceauth/token";
  const maxAttempts = params.maxAttempts ?? 180;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, params.intervalSeconds * 1000));
    }
    const body = new URLSearchParams({
      client_id: params.clientId,
      device_code: params.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok) {
      const idToken = json.id_token as string | undefined;
      if (!idToken) throw new Error("token response missing id_token");
      const info = extractAccountInfo(idToken);
      return {
        access: json.access_token as string,
        refresh: json.refresh_token as string,
        expires: Date.now() + (json.expires_in as number) * 1000,
        accountId: info.accountId,
        accountEmail: info.accountEmail,
      };
    }
    const error = json.error as string;
    if (error === "authorization_pending" || error === "slow_down") continue;
    throw new Error(`device authorization failed: ${error}`);
  }
  throw new Error("device authorization timed out after max polling attempts");
}
