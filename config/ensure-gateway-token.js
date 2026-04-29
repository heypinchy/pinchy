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
writeAtomic(configPath, JSON.stringify(config, null, 2), 0o644);
