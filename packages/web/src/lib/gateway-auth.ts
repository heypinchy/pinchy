import { readFileSync } from "fs";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

function readGatewayToken(): string | null {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return config?.gateway?.auth?.token ?? null;
  } catch {
    return null;
  }
}

export function validateGatewayToken(headers: Headers): boolean {
  const authHeader = headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7);
  const gatewayToken = readGatewayToken();
  if (!gatewayToken) return false;

  return token === gatewayToken;
}
