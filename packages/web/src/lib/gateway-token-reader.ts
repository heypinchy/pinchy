import { readFileSync } from "fs";
import { readSecretsFile } from "@/lib/openclaw-secrets";

/**
 * Reads the OpenClaw gateway token Pinchy needs to authenticate its
 * WebSocket connection.
 *
 * Source priority:
 *
 *   1. **openclaw.json `gateway.auth.token`** — written by
 *      `ensure-gateway-token.js` at every OpenClaw container start, plain
 *      string, mode 0644 on a shared volume Pinchy can read. Available
 *      from the moment OpenClaw boots, regardless of whether Pinchy's
 *      `regenerateOpenClawConfig()` has run yet.
 *
 *   2. **secrets.json `gateway.token`** — written by Pinchy's
 *      `writeSecretsFile()` after `regenerateOpenClawConfig()` runs (i.e.,
 *      only after setup completes or settings change). Mode 0600 in the
 *      production architecture (root-owned after our chown defense), so
 *      Pinchy (uid 999 in production) cannot read it directly anymore.
 *
 * Why the fallback matters: relying only on secrets.json was the bug.
 * On cold start (pre-setup-wizard or right after a fresh install),
 * secrets.json doesn't have a gateway.token yet. The old `readSecretsFile()`-only
 * implementation would time out, log "Gateway token not available after waiting",
 * and connect without a token. openclaw-node caches the unauthenticated
 * connection; subsequent reconnects keep failing with `reason=token_missing`
 * even after the token becomes available — Smithers can never reach OpenClaw.
 */
export function readGatewayToken(): string {
  try {
    const configPath = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      gateway?: { auth?: { token?: unknown } };
    };
    const tokenFromConfig = config.gateway?.auth?.token;
    if (typeof tokenFromConfig === "string" && tokenFromConfig.length > 0) {
      return tokenFromConfig;
    }
  } catch {
    // openclaw.json unreadable / malformed / missing — fall through.
  }
  try {
    return readSecretsFile().gateway?.token ?? "";
  } catch {
    return "";
  }
}
