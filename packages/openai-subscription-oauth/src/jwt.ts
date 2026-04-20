export function extractAccountInfo(idToken: string): { accountId: string; accountEmail: string } {
  const parts = idToken.split(".");
  if (parts.length < 2) throw new Error("invalid JWT: missing payload segment");
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as Record<string, unknown>;
  const authClaim = payload["https://openai.com/auth"] as { user_id?: string } | undefined;
  const accountId = authClaim?.user_id;
  const accountEmail = payload.email as string | undefined;
  if (!accountId || !accountEmail) {
    throw new Error("id_token missing expected claims (user_id or email)");
  }
  return { accountId, accountEmail };
}
