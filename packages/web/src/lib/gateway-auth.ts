import { timingSafeEqual } from "crypto";
import { readSecretsFile } from "@/lib/openclaw-secrets";

function readGatewayToken(): string | null {
  try {
    const secrets = readSecretsFile();
    return secrets.gateway?.token ?? null;
  } catch {
    return null;
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function validateGatewayToken(headers: Headers): boolean {
  const authHeader = headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7);
  const gatewayToken = readGatewayToken();
  if (!gatewayToken) return false;

  return constantTimeEqual(token, gatewayToken);
}
