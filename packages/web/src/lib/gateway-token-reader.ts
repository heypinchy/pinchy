import { readFileSync } from "fs";
import { readSecretsFile } from "@/lib/openclaw-secrets";

/**
 * Reads the OpenClaw gateway token Pinchy needs to authenticate its
 * WebSocket connection, and that `validateGatewayToken()` compares every
 * plugin's Bearer token against on the internal routes.
 *
 * Source priority:
 *
 *   1. **openclaw.json `gateway.auth.token`** — written by Pinchy's
 *      `regenerateOpenClawConfig()` at startup (before OpenClaw starts,
 *      thanks to the Docker Compose healthcheck dependency). Plain string.
 *
 *   2. **secrets.json `gateway.token`** — written by Pinchy's
 *      `writeSecretsFile()` as part of `regenerateOpenClawConfig()`.
 *      Fallback in case openclaw.json is briefly unavailable — but only
 *      where Pinchy can read secrets.json at all (dev, tests).
 *      start-openclaw.sh chowns it root:root 0600 for OpenClaw's own
 *      resolver, so in the production container this read fails too.
 *
 *   3. **The last token read successfully** — when neither file yields a
 *      token. OpenClaw rewrites openclaw.json root-only on every config
 *      apply until start-openclaw.sh chmods it back, so right after an
 *      agent is created or changed both reads can fail. Without this, every plugin
 *      call to an internal route in that window is answered 401: the audit
 *      hook fails and blocks the tool call, a context save is lost. A fresh
 *      read always wins, so a rotated token takes effect on the next
 *      successful read.
 */
let lastGoodToken = "";

export function readGatewayToken(): string {
  if (process.env.PINCHY_E2E_GATEWAY_TOKEN) {
    return process.env.PINCHY_E2E_GATEWAY_TOKEN;
  }

  const fresh = readGatewayTokenFromFiles();
  if (fresh) {
    lastGoodToken = fresh;
    return fresh;
  }
  return lastGoodToken;
}

function readGatewayTokenFromFiles(): string {
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
