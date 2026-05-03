#!/usr/bin/env node
"use strict";

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("fs");
const { randomBytes } = require("crypto");
const { dirname } = require("path");

const configPath =
  process.env.OPENCLAW_CONFIG_PATH || "/root/.openclaw/openclaw.json";
const secretsPath =
  process.env.OPENCLAW_SECRETS_PATH || "/openclaw-secrets/secrets.json";

function readJSON(p) {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function writeAtomic(p, content, mode) {
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, content, { encoding: "utf-8", mode });
}

const secrets = readJSON(secretsPath);
if (!secrets.gateway) secrets.gateway = {};
if (!secrets.gateway.token) {
  secrets.gateway.token = randomBytes(24).toString("hex");
}
// Mode 0644 (not 0600) because this is the cross-container handoff: the
// OpenClaw container (root) writes here, and the Pinchy container (non-root
// uid 999 in production) needs to read the gateway token before it can do
// any meaningful work. Defense-in-depth still holds via the tmpfs directory
// mode 0770 — only processes inside these two containers can reach this
// path. Once Pinchy regenerates the config post-setup, writeSecretsFile()
// rewrites the file as pinchy:pinchy mode 0600.
writeAtomic(secretsPath, JSON.stringify(secrets, null, 2), 0o644);
// Force-chmod even when the file already existed (writeFile preserves
// pre-existing modes), so a previous pinchy 0600 write doesn't lock root out
// of communicating the new token through to pinchy on next container start.
require("fs").chmodSync(secretsPath, 0o644);

const config = readJSON(configPath);
if (!config.gateway) config.gateway = {};
config.gateway.mode = config.gateway.mode || "local";
config.gateway.bind = config.gateway.bind || "lan";
// Keep gateway.auth.token as a plain string — OpenClaw requires a literal
// string for gateway authentication and does not resolve SecretRef objects
// in the gateway.auth block at startup.
config.gateway.auth = {
  mode: "token",
  token: secrets.gateway.token,
};
if (!config.secrets) {
  config.secrets = {
    providers: {
      pinchy: { source: "file", path: secretsPath, mode: "json" },
    },
  };
}
// Disable OpenClaw features that have no purpose in the Pinchy stack
// BEFORE the gateway boots, so the gateway starts already-tuned and
// no restart-classified config changes get triggered later.
//
// Each of these is restart-kind in OpenClaw's reload classifier, so
// writing them in the bootstrap (this file, before `openclaw gateway`
// runs) avoids the SIGUSR1 that would fire if Pinchy's later
// regenerate were the first writer.
//
//   - discovery.mdns.mode=off — Bonjour announcer hangs in
//     state=announcing inside Docker bridge networks (no multicast
//     routing); the watchdog SIGTERMs the gateway after ~16 s, costing
//     ~30 s of "Reconnecting to the agent…" downtime per cold start
//     (observed staging 2026-05-03). Pinchy connects via OPENCLAW_WS_URL
//     on the bridge and never needs mDNS.
//
//   - update.checkOnStart=false — Pinchy controls the OpenClaw version
//     via the Docker image tag; the npm-version check on every gateway
//     boot is wasted I/O.
//
//   - gateway.controlUi.enabled=false — Pinchy is the external control
//     surface (running its own UI on port 7777); OpenClaw's
//     `/__openclaw__/control/*` routes on port 18789 are unused, cost
//     memory, and add an attack surface we don't need.
//
//   - canvasHost.enabled=false — Pinchy doesn't render OpenClaw canvases
//     anywhere in its UI; keep the canvas host server off to reduce
//     exposed local services.
//
// Pinchy's regenerateOpenClawConfig() writes these same fields on every
// regenerate as an idempotent backstop, so they stay off across rewrites.
if (!config.discovery) config.discovery = {};
if (!config.discovery.mdns) config.discovery.mdns = {};
if (!config.discovery.mdns.mode) config.discovery.mdns.mode = "off";

if (!config.update) config.update = {};
if (config.update.checkOnStart === undefined) config.update.checkOnStart = false;

if (!config.gateway.controlUi) config.gateway.controlUi = {};
if (config.gateway.controlUi.enabled === undefined) config.gateway.controlUi.enabled = false;

if (!config.canvasHost) config.canvasHost = {};
if (config.canvasHost.enabled === undefined) config.canvasHost.enabled = false;

writeAtomic(configPath, JSON.stringify(config, null, 2), 0o644);
