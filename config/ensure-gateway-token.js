#!/usr/bin/env node
"use strict";

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("fs");
const { randomBytes } = require("crypto");
const { dirname } = require("path");

const configPath = process.argv[2] || "/root/.openclaw/openclaw.json";

function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

const config = readConfig();

if (!config.gateway) config.gateway = {};
if (!config.gateway.mode) config.gateway.mode = "local";
if (!config.gateway.bind) config.gateway.bind = "lan";

if (!config.gateway.auth || !config.gateway.auth.token) {
  config.gateway.auth = {
    mode: "token",
    token: randomBytes(24).toString("hex"),
  };
}

const dir = dirname(configPath);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

writeFileSync(configPath, JSON.stringify(config, null, 2), {
  encoding: "utf-8",
  mode: 0o600,
});
