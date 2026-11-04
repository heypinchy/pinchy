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
 *   3. **The last token read successfully** — only when openclaw.json could
 *      not be read or parsed, secrets.json gave no token either, and the
 *      reads have been failing for less than LAST_GOOD_TOKEN_MAX_AGE_MS.
 *      OpenClaw rewrites openclaw.json root-only on every config apply until
 *      start-openclaw.sh's 50 ms permission loop chmods it back, so right
 *      after an agent is created or changed the read can fail. Without this,
 *      every plugin call to an internal route in that window is answered
 *      401: the audit hook fails and blocks the tool call, a context save is
 *      lost.
 *
 *      What this deliberately does NOT cover: an openclaw.json that parses
 *      and carries no token. That is an answer, not a failed read, and it
 *      fails closed (""), as it always did. And the fallback ends after the
 *      cap: a config that stays unreadable is a broken deployment, which
 *      must surface as 401s rather than keep an old token valid forever.
 *      A fresh read always wins.
 */

/**
 * How long the remembered token may be served once the reads start failing.
 * Measured from the first failed read, not from the last good one: an
 * instance that served no internal call for a while must still cover the
 * next config apply. The real window is the time until start-openclaw.sh's
 * permission loop (50 ms tick) restores read access — far below this.
 */
export const LAST_GOOD_TOKEN_MAX_AGE_MS = 60_000;

let lastGoodToken = "";
let failingSince: number | undefined;

export function readGatewayToken(): string {
  if (process.env.PINCHY_E2E_GATEWAY_TOKEN) {
    return process.env.PINCHY_E2E_GATEWAY_TOKEN;
  }

  const read = readGatewayTokenFromFiles();
  if (read.token) {
    lastGoodToken = read.token;
    failingSince = undefined;
    return read.token;
  }
  if (read.configUnreadable && lastGoodToken) {
    failingSince ??= Date.now();
    if (Date.now() - failingSince < LAST_GOOD_TOKEN_MAX_AGE_MS) return lastGoodToken;
  }
  return "";
}

/**
 * The token as the files say it right now, never a remembered one. For a
 * caller that persists what it reads (`getOrCreateGatewayToken` writes it
 * into the settings DB, where it becomes the authoritative token): a durable
 * value is taken only from what the files say now, never from the
 * short-lived stand-in `readGatewayToken` keeps for validating requests.
 */
export function readGatewayTokenUncached(): string {
  if (process.env.PINCHY_E2E_GATEWAY_TOKEN) {
    return process.env.PINCHY_E2E_GATEWAY_TOKEN;
  }
  return readGatewayTokenFromFiles().token;
}

function readGatewayTokenFromFiles(): { token: string; configUnreadable: boolean } {
  let configUnreadable = false;
  try {
    const configPath = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      gateway?: { auth?: { token?: unknown } };
    };
    const tokenFromConfig = config.gateway?.auth?.token;
    if (typeof tokenFromConfig === "string" && tokenFromConfig.length > 0) {
      return { token: tokenFromConfig, configUnreadable };
    }
  } catch {
    // openclaw.json unreadable / mid-rewrite / malformed / missing.
    configUnreadable = true;
  }
  try {
    return { token: readSecretsFile().gateway?.token ?? "", configUnreadable };
  } catch {
    return { token: "", configUnreadable };
  }
}
